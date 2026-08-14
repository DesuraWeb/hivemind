import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LoopEvent } from '../../domain/run-state'
import { ensureProjectRepo } from '../../git/repo'
import { ensureRunWorktree } from '../../git/worktree'
import { createPullRequest, getPullRequest, listPullRequestFiles } from '../../integrations/github'
import type { StepHandler } from '../../jobs/run-step'
import type { RuntimeAdapter } from '../../runtime/types'
import { runSelfmodGate } from '../../security/selfmod-gate'
import { type StoredMessage, appendMessage, readRunMessages } from '../bus'
import { findPendingInstructions, instructionsBlock } from '../instructions'
import { resolveProjectRole } from '../roles'

const run = promisify(execFile)

export interface CodingDeps {
  adapter: RuntimeAdapter
  /** Racine des clones/worktrees (`WORKTREES_ROOT`, décision C du plan Phase 2). */
  worktreesRoot: string
}

/** `projects.repo_full_name` ("owner/repo") → URL clonable via le credential helper de `gh`. */
function githubRemoteUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`
}

// Identité posée par invocation (`-c`), jamais écrite dans la config du
// worktree partagé : le clone vient de `git clone`, sans user.name/email —
// écrire en config polluerait durablement le dépôt réutilisé entre runs.
const DEV_COMMIT_IDENTITY = [
  '-c',
  'user.name=Silithid Dev',
  '-c',
  'user.email=dev@silithid.invalid',
]

/** Filet de sécurité : commit tout ce que le dev a laissé non commité. */
async function commitIfDirty(worktreePath: string, message: string): Promise<void> {
  await run('git', ['add', '-A'], { cwd: worktreePath })
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: worktreePath })
  if (!stdout.trim()) return
  await run('git', [...DEV_COMMIT_IDENTITY, 'commit', '-m', message], { cwd: worktreePath })
}

/**
 * Le commit d'où part ce step : l'ancêtre commun entre la branche du run et sa
 * base. C'est l'état du dépôt d'AVANT le step, donc la cible d'un retour
 * arrière — c'est ce que le gate de mise en prod (Phase 5, Task 4) affiche
 * comme rollback côté code, et il ne l'affiche que s'il est réellement connu.
 *
 * `merge-base` plutôt que `rev-parse origin/<base>` : la base a pu avancer
 * depuis que la branche en a été extraite (le dépôt est partagé entre runs et
 * refetché), et pointer un commit que ce step n'a jamais vu ferait annoncer un
 * retour arrière faux. `null` en cas d'échec git : le gate dit alors qu'il ne
 * sait pas, ce qui est vrai — jamais faire échouer un run de dev pour ça.
 */
async function mergeBaseWithBase(worktreePath: string, base: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['merge-base', 'HEAD', `origin/${base}`], {
      cwd: worktreePath,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function commitsAheadOfBase(worktreePath: string, base: string): Promise<number> {
  const { stdout } = await run('git', ['rev-list', '--count', `origin/${base}..HEAD`], {
    cwd: worktreePath,
  })
  return Number.parseInt(stdout.trim(), 10)
}

function findFrame(
  messages: StoredMessage[],
): { body: string; acceptanceCriteria: string[] } | undefined {
  // La dernière passation garant→dev : en cas de nouvelle itération (J5+),
  // c'est celle-là qui doit cadrer le tour de dev en cours, pas la première.
  const frameMessage = [...messages]
    .reverse()
    .find((m) => m.kind === 'prompt' && m.fromRole === 'garant' && m.toRole === 'dev')
  if (!frameMessage) return undefined

  const rawCriteria = frameMessage.meta.acceptance_criteria
  const acceptanceCriteria = Array.isArray(rawCriteria)
    ? rawCriteria.filter((c): c is string => typeof c === 'string')
    : []
  return { body: frameMessage.body, acceptanceCriteria }
}

/**
 * Retours du reviewer sur le tour précédent (Task 11 : boucle dev↔reviewer).
 * `undefined` au premier tour (`reviewing.ts` n'a encore rien écrit) — le dev
 * travaille alors uniquement depuis le cadrage du garant, comme en Task 10.
 */
function findLatestReviewFeedback(messages: StoredMessage[]): string | undefined {
  const feedback = [...messages]
    .reverse()
    .find((m) => m.kind === 'report' && m.fromRole === 'reviewer' && m.toRole === 'dev')
  return feedback?.body
}

function prTitle(devPrompt: string): string {
  const firstLine = devPrompt.split('\n')[0]?.trim() || 'Step Silithid'
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
}

function commitSummary(devPrompt: string): string {
  return prTitle(devPrompt).slice(0, 72)
}

function prBody(opts: { devPrompt: string; acceptanceCriteria: string[]; report: string }): string {
  return [
    '## Cadrage du garant',
    opts.devPrompt,
    '',
    "## Critères d'acceptation",
    ...(opts.acceptanceCriteria.length > 0
      ? opts.acceptanceCriteria.map((c) => `- ${c}`)
      : ['(aucun critère explicite)']),
    '',
    '## Rapport du développeur',
    opts.report,
    '',
    '---',
    '_Ouverte automatiquement par Silithid._',
  ].join('\n')
}

/**
 * Handler réel de l'état `coding` (Task 10, critère J4). Le dev implémente le
 * `dev_prompt` du garant dans le worktree du run avec une session à surface
 * volontairement minimale (`{ bash: true, fs: 'write', mcp: [] }` — pas de
 * serveur MCP `git`/`gh` : ces entrées de `role_templates.dev.tools`
 * n'existent pas encore côté câblage réel, cf. la note Task 2 de
 * `runtime/tools.ts` sur `strictMcpConfig`). Le dev n'ouvre jamais lui-même
 * la PR malgré ce que suggère `bash: true` : c'est ce handler qui commit,
 * pousse et appelle `createPullRequest` — déterministe, pas laissé au hasard
 * d'un appel `gh` que l'agent aurait ou non pensé à faire.
 *
 * Rejoué après un `review_ko` (Task 11, boucle bornée à 3 — `decide()` dans
 * `domain/run-state.ts`) : `runs.pr_number` est alors déjà posé, donc ce
 * handler pousse les nouveaux commits sur la même branche sans rouvrir de
 * PR (`gh pr create` échoue sec sur une branche qui a déjà une PR ouverte) —
 * il relit juste son état via `getPullRequest`. Le prompt du dev inclut
 * aussi, à partir du deuxième tour, les points signalés par le reviewer.
 */
export function createCodingHandler(deps: CodingDeps): StepHandler {
  return async (db, runId) => {
    const runRow = await db
      .selectFrom('runs')
      .innerJoin('steps', 'steps.id', 'runs.step_id')
      .innerJoin('projects', 'projects.id', 'steps.project_id')
      .select([
        'runs.branch as branch',
        'runs.worktree_path as worktreePath',
        'runs.pr_number as prNumber',
        'steps.project_id as projectId',
        'projects.slug as projectSlug',
        'projects.repo_full_name as repoFullName',
        'projects.default_branch as defaultBranch',
      ])
      .where('runs.id', '=', runId)
      .executeTakeFirstOrThrow()

    const branch = runRow.branch ?? `run/${runId}`

    const messages = await readRunMessages(db, runId)
    const frame = findFrame(messages)
    if (!frame) {
      throw new Error(`run ${runId} : aucun cadrage garant→dev trouvé dans le bus (état coding)`)
    }

    const role = await resolveProjectRole(db, runRow.projectId, 'dev')

    const repoPath = await ensureProjectRepo({
      worktreesRoot: deps.worktreesRoot,
      projectSlug: runRow.projectSlug,
      remoteUrl: githubRemoteUrl(runRow.repoFullName),
    })
    const worktreePath = runRow.worktreePath ?? (await ensureRunWorktree(repoPath, runId))
    const reviewFeedback = findLatestReviewFeedback(messages)
    const instructions = findPendingInstructions(messages, 'dev')

    const prompt = [
      frame.body,
      '',
      "## Critères d'acceptation",
      ...(frame.acceptanceCriteria.length > 0
        ? frame.acceptanceCriteria.map((c) => `- ${c}`)
        : ['(aucun critère explicite — implémente au mieux le prompt ci-dessus)']),
      ...(reviewFeedback
        ? ['', '## Retours du reviewer à corriger (tour précédent)', reviewFeedback]
        : []),
      '',
      // Rendu vide sans consigne : le prompt d'un run ordinaire reste
      // rigoureusement identique à ce qu'il était avant cette tâche.
      ...instructionsBlock(instructions, '## Consigne de pilotage'),
      `Tu es déjà dans le worktree du run, sur la branche \`${branch}\` extraite depuis \`${runRow.defaultBranch}\`. Termine ta réponse par un rapport texte (ce que tu as fait, tes zones de doute) : l'ouverture de la pull request est prise en charge par l'orchestrateur, inutile de l'ouvrir toi-même.`,
    ].join('\n')

    const session = await deps.adapter.createSession({
      roleKey: 'dev',
      systemPrompt: role.systemPrompt,
      cwd: worktreePath,
      tools: { bash: true, fs: 'write', mcp: [] },
      onEvent: () => {},
    })

    const result = await deps.adapter.send(session, prompt)
    const report = result.text.trim() || '(le développeur n’a renvoyé aucun texte de rapport)'

    await commitIfDirty(worktreePath, `feat: ${commitSummary(frame.body)}`)

    const ahead = await commitsAheadOfBase(worktreePath, runRow.defaultBranch)
    if (ahead === 0) {
      throw new Error(
        `run ${runId} : aucun commit sur ${branch} au-delà de ${runRow.defaultBranch} — rien à proposer en pull request.`,
      )
    }

    await run('git', ['push', '-u', 'origin', `HEAD:${branch}`], { cwd: worktreePath })

    // Un `review_ko` renvoie ici avec `runs.pr_number` déjà posé (Task 11) :
    // la PR existe, on vient seulement d'y pousser de nouveaux commits — on
    // relit son état plutôt que d'en rouvrir une seconde sur la même branche.
    const pr = runRow.prNumber
      ? await getPullRequest(runRow.repoFullName, runRow.prNumber)
      : await createPullRequest({
          repoFullName: runRow.repoFullName,
          head: branch,
          base: runRow.defaultBranch,
          title: prTitle(frame.body),
          body: prBody({
            devPrompt: frame.body,
            acceptanceCriteria: frame.acceptanceCriteria,
            report,
          }),
          labels: [`silithid:run-${runId}`],
        })

    await db
      .updateTable('runs')
      .set({ branch, pr_number: pr.number, worktree_path: worktreePath })
      .where('id', '=', runId)
      .execute()

    // Le 4ᵉ gate (Task 6, Phase 4) : comparé EN PARALLÈLE du flux ordinaire,
    // pas à sa place — l'événement `pr_opened` ci-dessous continue de
    // traverser `decide()` normalement, que ce gate trouve une correspondance
    // ou non. Recalculé à chaque passage de ce handler (donc à chaque nouveau
    // tour dev↔reviewer, pas seulement à la création) : un commit ajouté au
    // deuxième tour qui touche la frontière de sécurité doit être vu tout
    // autant qu'un commit du premier tour.
    const changedFiles = await listPullRequestFiles(runRow.repoFullName, pr.number)
    await runSelfmodGate(db, {
      runId,
      projectId: runRow.projectId,
      prNumber: pr.number,
      prUrl: pr.url,
      files: changedFiles,
    })

    // La passation dev→garant : le rapport, plus l'endroit où trouver la PR.
    //
    // `changed_files` et `base_commit` s'ajoutent ici (Phase 5, Task 4) parce
    // que le gate de mise en prod en a besoin au moment du verdict, et que la
    // seule autre voie serait un second appel `gh` depuis `verdict.ts` — un
    // appel réseau de plus, sur une donnée que ce handler vient déjà de
    // récupérer pour le 4ᵉ gate. Réécrit à chaque tour dev↔reviewer : ce que
    // l'item de prod montrera est bien le dernier état de la PR.
    const baseCommit = await mergeBaseWithBase(worktreePath, runRow.defaultBranch)
    await appendMessage(db, {
      runId,
      fromRole: 'dev',
      toRole: 'garant',
      kind: 'report',
      body: report,
      meta: {
        pr_number: pr.number,
        pr_url: pr.url,
        branch,
        changed_files: changedFiles,
        base_ref: runRow.defaultBranch,
        base_commit: baseCommit,
      },
    })

    return { type: 'pr_opened', prNumber: pr.number } satisfies LoopEvent
  }
}

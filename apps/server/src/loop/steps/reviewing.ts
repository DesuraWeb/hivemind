import { z } from 'zod'
import type { LoopEvent } from '../../domain/run-state'
import { ensureProjectRepo } from '../../git/repo'
import { addReviewWorktree, removeReviewWorktree } from '../../git/worktree'
import type { StepHandler } from '../../jobs/run-step'
import { collectStructured } from '../../runtime/structured'
import type { RuntimeAdapter } from '../../runtime/types'
import { type StoredMessage, appendMessage, readRunMessages } from '../bus'
import { resolveProjectRole } from '../roles'

export interface ReviewingDeps {
  adapter: RuntimeAdapter
  /** Racine des clones/worktrees (`WORKTREES_ROOT`, décision C du plan Phase 2). */
  worktreesRoot: string
}

/** `projects.repo_full_name` ("owner/repo") → URL clonable via le credential helper de `gh`. */
function githubRemoteUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`
}

/**
 * Sortie structurée du reviewer (Task 11, plan Task 11 Step 2) — même
 * mécanique que le garant (`collectStructured`), jamais de texte libre :
 * c'est ce verdict, pas une lecture de prose, qui pilote `decide()`
 * (`review_ok` / `review_ko`).
 *
 * `points` reste un tableau simple (pas de règle croisée « KO ⇒ au moins un
 * point ») : `collectStructured` exige un `z.ZodObject` nu pour lire
 * `.shape` au moment de déclarer l'outil MCP — un `.refine()` produirait un
 * `ZodEffects` sans `.shape`, incompatible avec sa signature.
 */
const reviewSchema = z.object({
  verdict: z.enum(['OK', 'KO']),
  points: z
    .array(
      z.object({
        file: z.string().min(1),
        line: z.number().int().positive().optional(),
        action: z.string().min(5),
      }),
    )
    .default([]),
})
type Review = z.infer<typeof reviewSchema>

function findFrame(
  messages: StoredMessage[],
): { body: string; acceptanceCriteria: string[] } | undefined {
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

/** Le rapport du dev pour CE tour — le plus récent, pas forcément le premier. */
function findLatestDevReport(messages: StoredMessage[]): string | undefined {
  const report = [...messages]
    .reverse()
    .find((m) => m.kind === 'report' && m.fromRole === 'dev' && m.toRole === 'garant')
  return report?.body
}

/** Ce que CE reviewer a déjà signalé au tour précédent, pour vérifier que c'est résolu. */
function findLatestReviewFeedback(messages: StoredMessage[]): string | undefined {
  const feedback = [...messages]
    .reverse()
    .find((m) => m.kind === 'report' && m.fromRole === 'reviewer' && m.toRole === 'dev')
  return feedback?.body
}

function formatPoints(points: Review['points']): string {
  if (points.length === 0) {
    return 'KO — le reviewer n’a fourni aucun point actionnable détaillé.'
  }
  return points.map((p) => `- ${p.file}${p.line ? `:${p.line}` : ''} — ${p.action}`).join('\n')
}

function buildPreamble(opts: {
  projectName: string
  prNumber: number
  branch: string
  devPrompt: string
  acceptanceCriteria: string[]
  devReport: string
  reviewRound: number
  previousPoints?: string
}): string {
  return [
    '# Revue de code',
    `Projet : ${opts.projectName}`,
    `Pull request : #${opts.prNumber} (branche \`${opts.branch}\`)`,
    '',
    '# Cadrage initial du garant',
    opts.devPrompt,
    '',
    "# Critères d'acceptation",
    ...(opts.acceptanceCriteria.length > 0
      ? opts.acceptanceCriteria.map((c) => `- ${c}`)
      : ['(aucun critère explicite)']),
    '',
    '# Rapport du développeur',
    opts.devReport,
    ...(opts.previousPoints
      ? [
          '',
          '# Points signalés au tour précédent — vérifie qu’ils sont réellement résolus',
          opts.previousPoints,
        ]
      : []),
    '',
    '# Tour de revue',
    `review_round = ${opts.reviewRound}`,
    '',
    'Tu es dans un worktree propre, au commit exact poussé par le dev — pas son ' +
      'état de travail local. Lance réellement les tests (tu as `bash`, pas de ' +
      'confiance aveugle au rapport ci-dessus). Rends ton verdict en appelant ' +
      'l’outil de sortie structurée mis à ta disposition.',
  ].join('\n')
}

/**
 * Handler réel de l'état `reviewing` (Task 11, critère J5). Ne connaît rien
 * du comptage des allers-retours ni de la borne à 3 — cette règle vit
 * entièrement dans `decide()` (`domain/run-state.ts`, non modifié ici) : ce
 * handler ne fait que produire `review_ok` / `review_ko`, l'orchestrateur et
 * le domaine décident de la suite (nouveau tour de `coding`, ou
 * `awaiting_human` au troisième KO).
 *
 * Worktree DÉDIÉ, jamais celui du dev (`addReviewWorktree`, `git/worktree.ts`)
 * : détaché sur `origin/run/<id>`, donc sur exactement ce qui a été poussé —
 * si le reviewer travaillait dans le worktree du dev, il verrait aussi les
 * fichiers non commités de ce dernier et jugerait autre chose que ce qui
 * sera fusionné. Recréé à neuf à chaque tour (`removeReviewWorktree` avant
 * `addReviewWorktree`) : même après un crash en cours de revue, le tour
 * suivant repart d'un état propre plutôt que d'un reliquat.
 */
export function createReviewingHandler(deps: ReviewingDeps): StepHandler {
  return async (db, runId) => {
    const runRow = await db
      .selectFrom('runs')
      .innerJoin('steps', 'steps.id', 'runs.step_id')
      .innerJoin('projects', 'projects.id', 'steps.project_id')
      .select([
        'runs.branch as branch',
        'runs.pr_number as prNumber',
        'runs.review_round as reviewRound',
        'steps.project_id as projectId',
        'projects.slug as projectSlug',
        'projects.name as projectName',
        'projects.repo_full_name as repoFullName',
      ])
      .where('runs.id', '=', runId)
      .executeTakeFirstOrThrow()

    if (!runRow.branch || !runRow.prNumber) {
      throw new Error(`run ${runId} : aucune PR ouverte à revoir (état reviewing)`)
    }

    const role = await resolveProjectRole(db, runRow.projectId, 'reviewer')

    // Reviewer désactivé sur ce projet (`roles.enabled`) : la revue est sautée
    // et le code part au déploiement. C'est une boucle en solo, assumée — un
    // projet jetable, un prototype, un script interne où une seconde lecture
    // coûte plus qu'elle ne rapporte.
    //
    // L'état n'est PAS retiré de la machine : même arbitrage que
    // `juge_visuel` dans `deploying.ts`. `decide()` est un fichier sous garde,
    // et rendre la machine conditionnelle pour une option de projet la
    // rendrait illisible. L'état devient instantané, et la timeline dit
    // pourquoi plutôt que de laisser un `review_ok` inexpliqué — sans ce
    // message, une PR passée sans revue ressemble à une PR revue et validée.
    if (!role.enabled) {
      await appendMessage(db, {
        runId,
        fromRole: 'system',
        toRole: 'system',
        kind: 'info',
        body: 'Reviewer désactivé sur ce projet · aucune revue, la PR part au déploiement.',
        meta: { role_enabled: false },
      })
      return { type: 'review_ok' } satisfies LoopEvent
    }

    const messages = await readRunMessages(db, runId)
    const frame = findFrame(messages)
    if (!frame) {
      throw new Error(`run ${runId} : aucun cadrage garant→dev trouvé dans le bus (état reviewing)`)
    }
    const devReport = findLatestDevReport(messages)
    if (!devReport) {
      throw new Error(`run ${runId} : aucun rapport dev→garant trouvé dans le bus (état reviewing)`)
    }
    const previousPoints = findLatestReviewFeedback(messages)

    const repoPath = await ensureProjectRepo({
      worktreesRoot: deps.worktreesRoot,
      projectSlug: runRow.projectSlug,
      remoteUrl: githubRemoteUrl(runRow.repoFullName),
    })

    // Toujours neuf, jamais un reliquat d'un tour précédent ou d'un crash.
    await removeReviewWorktree(repoPath, runId)
    const worktreePath = await addReviewWorktree(repoPath, runId)

    try {
      const session = await deps.adapter.createSession({
        roleKey: 'reviewer',
        systemPrompt: role.systemPrompt,
        cwd: worktreePath,
        // Surface volontairement minimale, comme `coding.ts` (Task 10) : le
        // reviewer lit et exécute (`bash: true` — il lance réellement les
        // tests, brief §9) mais n'écrit jamais rien (`fs: 'read'`). `mcp: []`
        // pour la même raison que `coding.ts` : les entrées MCP de
        // `role_templates.reviewer.tools` (`git`, `gh`) ne sont pas encore
        // câblées côté runtime réel (cf. Task 2, `runtime/tools.ts`,
        // `strictMcpConfig`).
        tools: { bash: true, fs: 'read', mcp: [] },
        onEvent: () => {},
      })

      const preamble = buildPreamble({
        projectName: runRow.projectName,
        prNumber: runRow.prNumber,
        branch: runRow.branch,
        devPrompt: frame.body,
        acceptanceCriteria: frame.acceptanceCriteria,
        devReport,
        reviewRound: runRow.reviewRound,
        ...(previousPoints ? { previousPoints } : {}),
      })

      const review = await collectStructured(deps.adapter, session, preamble, reviewSchema, {
        toolName: 'submit_review',
        toolDescription: 'Rend le verdict de revue (verdict OK/KO, points actionnables).',
      })

      if (review.verdict === 'OK') {
        // Passation reviewer→garant : c'est lui qui statue en dernier ressort.
        await appendMessage(db, {
          runId,
          fromRole: 'reviewer',
          toRole: 'garant',
          kind: 'report',
          body: 'OK — la PR satisfait les critères d’acceptation vérifiés (tests exécutés réellement).',
          meta: { verdict: review.verdict, points: review.points, pr_number: runRow.prNumber },
        })
        return { type: 'review_ok' } satisfies LoopEvent
      }

      // Passation reviewer→dev : c'est lui qui doit corriger avant le tour suivant.
      await appendMessage(db, {
        runId,
        fromRole: 'reviewer',
        toRole: 'dev',
        kind: 'report',
        body: formatPoints(review.points),
        meta: { verdict: review.verdict, points: review.points, pr_number: runRow.prNumber },
      })
      return { type: 'review_ko' } satisfies LoopEvent
    } finally {
      // Le worktree de revue ne sert que le temps d'un tour — jamais gardé
      // ouvert entre deux passages en `reviewing` (contrairement à celui du
      // dev, réutilisé d'un tour de `coding` à l'autre).
      await removeReviewWorktree(repoPath, runId)
    }
  }
}

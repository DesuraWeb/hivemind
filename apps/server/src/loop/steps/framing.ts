import type { LoopEvent } from '../../domain/run-state'
import { ensureProjectRepo } from '../../git/repo'
import { addRunWorktree } from '../../git/worktree'
import type { StepHandler } from '../../jobs/run-step'
import { collectStructured, frameSchema } from '../../runtime/structured'
import type { RuntimeAdapter, ToolPolicy } from '../../runtime/types'
import { appendMessage } from '../bus'
import { resolveProjectRole } from '../roles'

export interface FramingDeps {
  adapter: RuntimeAdapter
  /** Racine des clones/worktrees (`WORKTREES_ROOT`, décision C du plan Phase 2). */
  worktreesRoot: string
}

/** `projects.repo_full_name` ("owner/repo") → URL clonable via le credential helper de `gh`. */
function githubRemoteUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`
}

/** Exporté : `inbox/optimize.ts` (Task « réponse optimisée par Hive ») construit le même résumé pour le majordome. */
export interface ClientRow {
  name: string
  tone: string | null
  notes: unknown
}

interface ClientNote {
  q?: string
  a?: string
}

function isClientNote(value: unknown): value is ClientNote {
  return typeof value === 'object' && value !== null
}

/** Résumé de la fiche client injecté au garant — brief : « consulte la fiche client ». */
export function clientSummary(client: ClientRow | undefined): string {
  if (!client) return 'Aucun client associé à ce projet — rien à consulter côté fiche client.'

  const lines = [`Client : ${client.name}`]
  if (client.tone) lines.push(`Ton attendu : ${client.tone}`)

  const notes = Array.isArray(client.notes) ? client.notes.filter(isClientNote) : []
  // Les plus récentes seulement : le préambule doit rester lisible par l'agent.
  for (const note of notes.slice(-5)) {
    if (note.q && note.a) lines.push(`- Q : ${note.q} — R : ${note.a}`)
  }
  return lines.join('\n')
}

function buildPreamble(opts: {
  projectName: string
  projectContext: string | null
  stepTitle: string
  specs: string
  client: string
  iteration: number
  maxIterations: number
}): string {
  return [
    '# Contexte projet',
    `Projet : ${opts.projectName}`,
    opts.projectContext ?? '(aucun contexte projet renseigné)',
    '',
    '# Fiche client',
    opts.client,
    '',
    `# Step à cadrer — ${opts.stepTitle}`,
    opts.specs,
    '',
    '# Itération',
    `iteration = ${opts.iteration}`,
    `max_iterations = ${opts.maxIterations}`,
    '',
    'Cadre ce step en appelant l’outil de sortie structurée mis à ta disposition.',
  ].join('\n')
}

/**
 * Handler réel de l'état `framing` (Task 10, critère J4). Même assemblage que
 * le handler factice prouvé par Task 9 (`tests/loop-j3.test.ts`) — rôle,
 * clone + worktree, sortie structurée, bus — avec un `RuntimeAdapter` réel à
 * la place du `FakeAdapter`, et le préambule complet (contexte projet, specs,
 * fiche client, itération) que `garant.md` attend explicitement.
 *
 * Contrairement au handler factice, ce worktree n'est PAS nettoyé en sortie :
 * `coding.ts` y travaille juste après, sur la même branche `run/<runId>`.
 * Le chemin est persisté dans `runs.worktree_path`/`runs.branch` pour que
 * `coding.ts` (et une reprise après crash) le retrouvent sans le redériver.
 */
export function createFramingHandler(deps: FramingDeps): StepHandler {
  return async (db, runId) => {
    const runRow = await db
      .selectFrom('runs')
      .innerJoin('steps', 'steps.id', 'runs.step_id')
      .innerJoin('projects', 'projects.id', 'steps.project_id')
      .select([
        'runs.iteration as iteration',
        'steps.title as stepTitle',
        'steps.specs as specs',
        'steps.max_iterations as maxIterations',
        'steps.project_id as projectId',
        'projects.slug as projectSlug',
        'projects.name as projectName',
        'projects.context as projectContext',
        'projects.repo_full_name as repoFullName',
        'projects.client_id as clientId',
      ])
      .where('runs.id', '=', runId)
      .executeTakeFirstOrThrow()

    const client = runRow.clientId
      ? await db
          .selectFrom('clients')
          .select(['name', 'tone', 'notes'])
          .where('id', '=', runRow.clientId)
          .executeTakeFirst()
      : undefined

    const role = await resolveProjectRole(db, runRow.projectId, 'garant')

    const repoPath = await ensureProjectRepo({
      worktreesRoot: deps.worktreesRoot,
      projectSlug: runRow.projectSlug,
      remoteUrl: githubRemoteUrl(runRow.repoFullName),
    })
    const worktreePath = await addRunWorktree(repoPath, runId)

    await db
      .updateTable('runs')
      .set({ worktree_path: worktreePath, branch: `run/${runId}` })
      .where('id', '=', runId)
      .execute()

    const session = await deps.adapter.createSession({
      roleKey: 'garant',
      systemPrompt: role.systemPrompt,
      cwd: worktreePath,
      // Persisté en JSON (`role_templates.tools`) donc non typé à la lecture :
      // la forme est garantie par `db/seed.ts` (TOOLS), pas par le compilateur.
      tools: role.tools as unknown as ToolPolicy,
      onEvent: () => {},
    })

    const preamble = buildPreamble({
      projectName: runRow.projectName,
      projectContext: runRow.projectContext,
      stepTitle: runRow.stepTitle,
      specs: runRow.specs,
      client: clientSummary(client),
      iteration: runRow.iteration,
      maxIterations: runRow.maxIterations,
    })

    const frame = await collectStructured(deps.adapter, session, preamble, frameSchema, {
      toolName: 'submit_frame',
      toolDescription: 'Rend le cadrage du step (dev_prompt, acceptance_criteria, pages_to_judge).',
    })

    // La passation garant→dev : c'est elle que coding.ts (et le dev) lira.
    await appendMessage(db, {
      runId,
      fromRole: 'garant',
      toRole: 'dev',
      kind: 'prompt',
      body: frame.dev_prompt,
      meta: {
        acceptance_criteria: frame.acceptance_criteria,
        pages_to_judge: frame.pages_to_judge,
      },
    })

    return { type: 'frame_ready' } satisfies LoopEvent
  }
}

/**
 * Handler réel de l'état `verdict` (Task 4, Phase 4). Le contrat de sortie
 * (`verdictSchema`, `../../runtime/structured.ts`) est figé depuis la Phase 2
 * — ce fichier ne fait que le consommer via `collectStructured`, jamais le
 * redéfinir (plan, « Contrats à respecter »).
 *
 * Le garant tranche depuis TROIS sources déjà dans le bus, jamais en relisant
 * le code ou les captures lui-même : le cadrage initial (`framing.ts`), le
 * rapport du reviewer (`reviewing.ts`, toujours un simple OK — un KO n'atteint
 * jamais le garant, il boucle dev↔reviewer sans lui) et le rapport du juge
 * visuel (`judging.ts`, conformités + écarts, sans aucune décision — « le
 * juge décrit, le garant décide »).
 */

import type { LoopEvent } from '../../domain/run-state'
import type { StepHandler } from '../../jobs/run-step'
import { type Verdict, collectStructured, verdictSchema } from '../../runtime/structured'
import type { RuntimeAdapter, ToolPolicy } from '../../runtime/types'
import { type StoredMessage, appendMessage, readRunMessages } from '../bus'
import { resolveProjectRole } from '../roles'

export interface VerdictDeps {
  adapter: RuntimeAdapter
}

/** Le cadrage garant→dev le plus récent (même passation que `judging.ts`/`reviewing.ts` lisent). */
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

/**
 * Le seul rapport reviewer→garant possible : `reviewing.ts` n'écrit JAMAIS à
 * destination du garant sur un KO (il boucle dev↔reviewer, ou bascule en
 * `awaiting_human` à la borne) — ce que le garant lit ici est toujours la
 * confirmation OK du dernier tour.
 */
function findLatestReviewerReport(messages: StoredMessage[]): string | undefined {
  const report = [...messages]
    .reverse()
    .find((m) => m.kind === 'report' && m.fromRole === 'reviewer' && m.toRole === 'garant')
  return report?.body
}

/** Le rapport du juge visuel pour CE tour (`judging.ts`) — corps déjà formaté, pas la peine de reparser `meta`. */
function findLatestJudgeReport(messages: StoredMessage[]): string | undefined {
  const report = [...messages]
    .reverse()
    .find((m) => m.kind === 'report' && m.fromRole === 'judge' && m.toRole === 'garant')
  return report?.body
}

function buildPreamble(opts: {
  projectName: string
  devPrompt: string
  acceptanceCriteria: string[]
  reviewerReport: string
  judgeReport: string
  iteration: number
  maxIterations: number
}): string {
  // Dernière itération : aucun tour suivant n'appliquera `dev_prompt_correctif`
  // — le garant du prompt (garant.md, « Itération ») dit déjà cette règle pour
  // le cadrage (`dev_prompt`) ; on la répète ici, appliquée explicitement au
  // VERDICT, parce que rien dans le prompt de rôle ne mentionne littéralement
  // `dev_prompt_correctif`. C'est le point que le plan (Task 4, point 3)
  // demande de vérifier par l'observation, pas seulement par lecture du prompt.
  const isLastIteration = opts.iteration >= opts.maxIterations

  return [
    '# Verdict du garant',
    `Projet : ${opts.projectName}`,
    '',
    '# Cadrage initial de ce step',
    opts.devPrompt,
    '',
    "# Critères d'acceptation",
    ...(opts.acceptanceCriteria.length > 0
      ? opts.acceptanceCriteria.map((c) => `- ${c}`)
      : ['(aucun critère explicite)']),
    '',
    '# Rapport du reviewer',
    opts.reviewerReport,
    '',
    '# Rapport du juge visuel',
    opts.judgeReport,
    '',
    '# Itération',
    `iteration = ${opts.iteration}`,
    `max_iterations = ${opts.maxIterations}`,
    ...(isLastIteration
      ? [
          '',
          "C'est ta DERNIÈRE itération : si tu rends « ecarts », il n'y aura aucun tour suivant " +
            'pour appliquer un `dev_prompt_correctif` — le run s’arrêtera directement en échec, ' +
            'avec une alerte pour un humain. Réserve « ecarts » aux écarts réellement bloquants ' +
            "qu'il faut signaler ainsi. Pour tout le reste (écarts majeurs ou mineurs, sans écart " +
            'bloquant), rends « conforme » : arbitre, assume dans ta réponse ce que tu choisis de ' +
            'ne pas corriger, plutôt que de produire un correctif qui ne tournera jamais.',
        ]
      : [
          '',
          'Il reste au moins une itération après celle-ci. Si tu rends « ecarts », tu DOIS remplir ' +
            "`dev_prompt_correctif` : c'est le seul prompt que le développeur recevra au tour " +
            "suivant — sans lui, il ne saura pas quoi corriger et repartira à l'aveugle. Rédige-le " +
            'comme un cadrage à part entière (objectif, contraintes), pas comme une simple liste ' +
            'de points à cocher.',
        ]),
    '',
    'Rends ton verdict en appelant l’outil de sortie structurée mis à ta disposition. Un écart ' +
      "cosmétique non couvert par un critère d'acceptation n'est pas un écart : ce n'est pas un " +
      'motif pour rendre « ecarts ».',
  ].join('\n')
}

function formatVerdict(verdict: Verdict): string {
  if (verdict.decision === 'conforme') {
    const lines = ['Conforme — le step répond aux critères d’acceptation.']
    if (verdict.ecarts.length > 0) {
      lines.push(
        '',
        'Écarts jugés non bloquants, acceptés en l’état :',
        ...verdict.ecarts.map((e) => `- [${e.severite}] ${e.description} — ${e.correctif}`),
      )
    }
    return lines.join('\n')
  }

  const lines = [
    `Écarts (${verdict.ecarts.length}) — itération corrective requise.`,
    '',
    ...verdict.ecarts.map((e) => `- [${e.severite}] ${e.description} — ${e.correctif}`),
  ]
  return lines.join('\n')
}

/**
 * Handler réel de l'état `verdict` (Task 4, Phase 4). Émet `verdict_conforme`
 * ou `verdict_ecarts` — `decide()` (`domain/run-state.ts`, non modifié)
 * décide seule de la suite (gate humain, `done`, nouvelle itération, ou
 * `failed` si `max_iterations` est atteint).
 *
 * `cwd` de la session : le worktree du run (`runs.worktree_path`), posé par
 * `framing.ts` et jamais nettoyé avant la fin du run (contrairement au
 * worktree dédié de `reviewing.ts`) — donc toujours présent à ce stade de la
 * boucle. Le garant n'y lit rien ici (`fs: 'read'` du rôle sans instruction
 * de le faire, plan : il tranche depuis les rapports du bus, pas en
 * relisant le code), mais `CreateSessionOptions.cwd` est un champ requis et
 * ce chemin reste le plus honnête disponible.
 */
export function createVerdictHandler(deps: VerdictDeps): StepHandler {
  return async (db, runId) => {
    const runRow = await db
      .selectFrom('runs')
      .innerJoin('steps', 'steps.id', 'runs.step_id')
      .innerJoin('projects', 'projects.id', 'steps.project_id')
      .select([
        'runs.iteration as iteration',
        'runs.worktree_path as worktreePath',
        'steps.max_iterations as maxIterations',
        'steps.project_id as projectId',
        'projects.name as projectName',
      ])
      .where('runs.id', '=', runId)
      .executeTakeFirstOrThrow()

    if (!runRow.worktreePath) {
      throw new Error(
        `run ${runId} : aucun worktree enregistré (runs.worktree_path) — état verdict`,
      )
    }

    const messages = await readRunMessages(db, runId)
    const frame = findFrame(messages)
    if (!frame) {
      throw new Error(`run ${runId} : aucun cadrage garant→dev trouvé dans le bus (état verdict)`)
    }
    const reviewerReport = findLatestReviewerReport(messages)
    if (!reviewerReport) {
      throw new Error(
        `run ${runId} : aucun rapport reviewer→garant trouvé dans le bus (état verdict)`,
      )
    }
    const judgeReport = findLatestJudgeReport(messages)
    if (!judgeReport) {
      throw new Error(`run ${runId} : aucun rapport juge→garant trouvé dans le bus (état verdict)`)
    }

    const role = await resolveProjectRole(db, runRow.projectId, 'garant')

    const session = await deps.adapter.createSession({
      roleKey: 'garant',
      systemPrompt: role.systemPrompt,
      cwd: runRow.worktreePath,
      // Persisté en JSON (`role_templates.tools`) donc non typé à la lecture,
      // même remarque que `framing.ts` : la forme est garantie par
      // `db/seed.ts` (TOOLS), pas par le compilateur.
      tools: role.tools as unknown as ToolPolicy,
      onEvent: () => {},
    })

    const preamble = buildPreamble({
      projectName: runRow.projectName,
      devPrompt: frame.body,
      acceptanceCriteria: frame.acceptanceCriteria,
      reviewerReport,
      judgeReport,
      iteration: runRow.iteration,
      maxIterations: runRow.maxIterations,
    })

    const verdict = await collectStructured(deps.adapter, session, preamble, verdictSchema, {
      toolName: 'submit_verdict',
      toolDescription:
        'Rend le verdict du garant : conforme, ou écarts avec leurs correctifs et le prompt correctif pour le dev.',
    })

    // Passation d'audit garant→system : trace la décision elle-même dans la
    // timeline, que le mode soit `gated` (approbation humaine à suivre) ou
    // `auto` (le run se termine directement) — sans elle, un verdict
    // `conforme` ne laisserait aucune trace de ce qui a été accepté.
    await appendMessage(db, {
      runId,
      fromRole: 'garant',
      toRole: 'system',
      kind: 'report',
      body: formatVerdict(verdict),
      meta: { decision: verdict.decision, ecarts: verdict.ecarts },
    })

    if (verdict.decision === 'conforme') {
      return { type: 'verdict_conforme' } satisfies LoopEvent
    }

    // Sur écarts : la passation que `framing.ts` (Task 5) lira à l'itération
    // suivante pour cadrer le tour corrigé — écrite seulement si le garant a
    // réellement produit un `dev_prompt_correctif` (champ optionnel du
    // contrat figé ; à la dernière itération, un écart bloquant peut être
    // rendu sans correctif puisqu'aucun tour suivant ne le lira jamais, voir
    // `decide()` : `verdict_ecarts` à `iteration === max_iterations` bascule
    // direction `failed`, jamais `framing`).
    if (verdict.dev_prompt_correctif) {
      await appendMessage(db, {
        runId,
        fromRole: 'garant',
        toRole: 'dev',
        kind: 'correction',
        body: verdict.dev_prompt_correctif,
        meta: { ecarts: verdict.ecarts },
      })
    }

    return { type: 'verdict_ecarts' } satisfies LoopEvent
  }
}

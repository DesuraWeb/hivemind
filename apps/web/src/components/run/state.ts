import { RUN_STATES, type RunState } from '@silithid/shared'
import type { RunDetailView, RunTimelineEntry } from '../../lib/api'

/**
 * Lecture d'un état de run pour l'écran « Run en direct ».
 *
 * `RunDetailView.state` est typé `string` côté front (api.ts) : la route rend
 * la colonne telle quelle. On le rétrécit ici plutôt que de laisser chaque
 * composant comparer des chaînes libres — et un état inconnu (migration à
 * venir) retombe sur un ton neutre au lieu de casser le rendu.
 */
export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value)
}

/**
 * Ce que l'état dit du run, en quatre situations qui appellent chacune des
 * gestes différents :
 *
 * - `advancing` : la boucle tourne, un rôle a la main (ACTIVE_STATES du
 *   serveur, domain/run-state.ts) — pause et arrêt possibles ;
 * - `waiting` : `awaiting_human`, la boucle attend une réponse d'inbox — ni
 *   pause (la machine la refuse) ni reprise depuis ici ;
 * - `paused` : une des deux pauses — la reprise manuelle n'existe que pour
 *   `paused_human`, le budget se relève tout seul ;
 * - `ended` : les trois terminaux, dont `stopped` qui n'est PAS un échec.
 */
export type RunPhase = 'advancing' | 'waiting' | 'paused' | 'ended'

export interface RunTone {
  label: string
  color: string
  pulse: boolean
  phase: RunPhase
}

/**
 * État → libellé et couleur du bandeau.
 *
 * Le pack (`Run en direct.dc.html`) n'écrit que trois situations dans son
 * chip : « en cours », « pause demandée », « stoppée ». Le serveur en rend
 * treize, et les distinguer est justement ce qu'on vient regarder sur cet
 * écran : on nomme donc l'étape (« revue », « verdict »…) plutôt que de
 * réduire sept états actifs à « en cours ».
 *
 * `stopped` reçoit un gris neutre, pas le rouge d'alerte que le pack donne à
 * sa bannière d'arrêt : un arrêt est une décision, pas une panne. Le pack ne
 * connaît que quatre états de boucle et n'a aucun visuel pour celui-là — écart
 * assumé, et c'est la seule lecture juste (cf. `loopFromRunState` côté
 * serveur, qui sépare `stop` de `fail` pour la même raison).
 */
export function runStateTone(state: string): RunTone {
  if (!isRunState(state)) {
    return { label: state, color: 'var(--text-low)', pulse: false, phase: 'ended' }
  }
  switch (state) {
    case 'framing':
      return { label: 'cadrage', color: 'var(--accent)', pulse: true, phase: 'advancing' }
    case 'coding':
      return { label: 'développement', color: 'var(--accent)', pulse: true, phase: 'advancing' }
    case 'design_wait':
      return { label: 'attente design', color: 'var(--accent)', pulse: true, phase: 'advancing' }
    case 'reviewing':
      return { label: 'revue', color: 'var(--sem-question)', pulse: true, phase: 'advancing' }
    case 'deploying':
      return { label: 'déploiement', color: 'var(--accent)', pulse: true, phase: 'advancing' }
    case 'judging':
      return { label: 'jugement', color: 'var(--sem-verdict)', pulse: true, phase: 'advancing' }
    case 'verdict':
      return { label: 'verdict', color: 'var(--sem-verdict)', pulse: true, phase: 'advancing' }
    case 'awaiting_human':
      return {
        label: 'en attente humain',
        color: 'var(--sem-question)',
        pulse: false,
        phase: 'waiting',
      }
    case 'paused_human':
      return { label: 'pause · vous', color: 'var(--pause)', pulse: false, phase: 'paused' }
    case 'paused_budget':
      return { label: 'pause · budget', color: 'var(--pause)', pulse: false, phase: 'paused' }
    case 'done':
      return { label: 'terminée', color: 'var(--ok)', pulse: false, phase: 'ended' }
    case 'failed':
      return { label: 'échec', color: 'var(--sem-alert)', pulse: false, phase: 'ended' }
    case 'stopped':
      return { label: 'stoppée', color: 'var(--text-low)', pulse: false, phase: 'ended' }
  }
}

/** Les quatre pastilles du pipeline, dans l'ordre du pack : garant → dev → reviewer → juge. */
export const PIPELINE_ROLES = ['garant', 'dev', 'reviewer', 'judge'] as const
export type PipelineRole = (typeof PIPELINE_ROLES)[number]

/** `judge` → « juge » (français, comme `data.js` et `projects/derive.ts`). */
export function roleLabel(role: string): string {
  switch (role) {
    case 'judge':
      return 'juge'
    case 'majordome':
      return 'hive'
    case 'system':
      return 'boucle'
    default:
      return role
  }
}

/**
 * Couleurs de rôle reprises telles quelles de `Component.RC` du pack :
 * garant bleu glacier, dev accent, reviewer question, juge verdict, humain
 * `--ok`, « boucle » (les transitions d'état) `--pause`.
 */
export const ROLE_COLOR: Record<string, string> = {
  garant: 'oklch(0.82 0.06 235)',
  dev: 'var(--accent)',
  reviewer: 'var(--sem-question)',
  judge: 'var(--sem-verdict)',
  system: 'var(--pause)',
  human: 'var(--ok)',
}

export function roleColor(role: string): string {
  return ROLE_COLOR[role] ?? 'var(--text-mid)'
}

/**
 * Rôle qui a la main. Miroir exact de `ROLE_BY_ACTIVE_STATE`
 * (apps/server/src/projects/derive.ts) : la fiche projet écrit « dev au
 * travail » à partir de la même table, les deux écrans ne peuvent pas se
 * contredire.
 *
 * `verdict` est attribué au juge et non au garant qui le rédige : c'est le
 * choix du serveur (`role_templates` nomme cette étape du pipeline « judge »),
 * et en diverger ferait dire deux choses différentes au même instant.
 *
 * `deploying` revient au dev (son code part en prod), `design_wait` à
 * personne — aucun handler ne le pilote à ce jour.
 */
const ROLE_BY_STATE: Partial<Record<RunState, PipelineRole>> = {
  framing: 'garant',
  coding: 'dev',
  reviewing: 'reviewer',
  deploying: 'dev',
  judging: 'judge',
  verdict: 'judge',
}

/**
 * Le rôle interrompu quand le run ne tourne pas : `awaiting_human` et les deux
 * pauses gardent dans `resume_state` l'étape à laquelle ils repartiront. C'est
 * l'essentiel de l'information — « en pause » seul ne dit pas qui a été
 * coupé.
 */
export function activeRole(run: Pick<RunDetailView, 'state' | 'resumeState'>): PipelineRole | null {
  const tone = runStateTone(run.state)
  if (tone.phase === 'ended') return null
  const source = tone.phase === 'advancing' ? run.state : (run.resumeState ?? run.state)
  if (!isRunState(source)) return null
  return ROLE_BY_STATE[source] ?? null
}

export interface PipelineNode {
  role: PipelineRole
  label: string
  color: string
  status: 'active' | 'passed' | 'idle'
  /** Ligne de méta sous le nom : « au travail », « en pause », « passé », « à venir ». */
  meta: string
}

/**
 * Le pipeline tel qu'il est réellement, pas tel qu'on l'imagine.
 *
 * « passé » n'est pas déduit de la position du rôle dans la chaîne (le pack le
 * fait, mais dev↔reviewer boucle : le reviewer peut avoir parlé trois fois
 * avant que le juge existe) — il est déduit de la timeline : un rôle est passé
 * s'il a écrit au moins un message dans ce run. C'est la seule preuve qu'on
 * ait qu'il ait fait quelque chose.
 */
export function buildPipeline(
  run: Pick<RunDetailView, 'state' | 'resumeState' | 'timeline'>,
): PipelineNode[] {
  const spoke = new Set(run.timeline.map((m) => m.fromRole))
  const active = activeRole(run)
  const tone = runStateTone(run.state)

  return PIPELINE_ROLES.map((role): PipelineNode => {
    const isActive = role === active
    const status = isActive ? 'active' : spoke.has(role) ? 'passed' : 'idle'
    let meta: string
    if (isActive) {
      // « termine son action » et non « arrêté net » : la pause prend effet au
      // ré-enfilement du worker, l'invocation en cours va à son terme.
      if (tone.phase === 'advancing') meta = 'au travail'
      else if (tone.phase === 'paused') meta = 'termine son action…'
      else meta = 'attend une réponse'
    } else if (status === 'passed') {
      meta = 'passé'
    } else {
      meta = 'à venir'
    }
    return { role, label: roleLabel(role), color: roleColor(role), status, meta }
  })
}

/** Un message du bus écrit par Florian (`loop/instructions.ts`), pas par un agent. */
export function isHumanInstruction(entry: RunTimelineEntry): boolean {
  return entry.kind === 'correction' && entry.fromRole === 'system' && entry.meta.source === 'human'
}

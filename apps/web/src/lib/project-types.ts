import type { AutonomyMode, InboxType, RunState } from '@silithid/shared'

export interface PendingCount {
  type: InboxType
  n: number
}

/**
 * Statut *projet* agrégé, jamais stocké (miroir de `LoopStatus`,
 * apps/server/src/projects/derive.ts). `demarrage` : projet sans aucun run
 * encore démarré — absent de l'énum `badgeFor` de data.js (pack DA), géré
 * ici par un badge propre (Dashboard.tsx).
 */
export type LoopStatus = 'run' | 'wait' | 'fail' | 'done' | 'pause' | 'demarrage'

/**
 * Miroir front de `ProjectView` (apps/server/src/projects/repo.ts) : la forme
 * exacte rendue par `GET /api/projects`, alignée sur `PROJECTS[]` de
 * `docs/design/data.js`. `nodes` reste `null` tant que J13 ne le dérive pas
 * de l'activité réelle du projet — `orb.js` retombe alors sur 200 (poids égal
 * pour tous les clusters), c'est le comportement attendu de cette phase.
 */
export interface ProjectView {
  id: string
  name: string
  client: string | null
  stack: string | null
  step: [number, number]
  loop: LoopStatus
  role: string | null
  iteration: [number, number] | null
  duree: string
  tint: string | null
  nodes: number | null
  pending: PendingCount[]
  conso: string
  synth: string | null
  staging: string | null
  line: string
  /**
   * Slug du globe qui contient le projet (`projects.globe_id` est NOT NULL
   * depuis la migration 0002 : jamais vide). Sert au fil d'Ariane « Globes /
   * <globe> / <projet> » quand on arrive sur une fiche sans passer par
   * l'intérieur du globe (⌘K, lien direct).
   */
  globe: string
}

/**
 * Miroir front de `StepView` (apps/server/src/projects/repo.ts) : la forme
 * rendue par `GET /api/projects/:slug/steps`, triée par `position`.
 *
 * `status` a cinq valeurs là où le pack DA (`Projet.dc.html`, `STEPS[].state`)
 * n'en connaît que quatre (done / run / prod / todo) : `failed` n'a aucun
 * visuel dans le prototype. Le mapping est fait par `stepTone`
 * (components/project/steps.ts), pas ici.
 */
export interface StepView {
  id: string
  position: number
  title: string
  specs: string
  autonomy: AutonomyMode | null
  maxIterations: number
  budgetTokens: number | null
  status: 'pending' | 'running' | 'awaiting_human' | 'validated' | 'failed'
  createdAt: string
}

/**
 * Miroir front de `RunView` (apps/server/src/projects/repo.ts) : la forme
 * rendue par `GET /api/projects/:slug/runs`, triée du plus récent au plus
 * ancien. Pas de `worktreePath` — le serveur ne l'expose délibérément pas.
 */
export interface RunView {
  id: string
  stepId: string
  iteration: number
  state: RunState
  branch: string | null
  prNumber: number | null
  resumeState: RunState | null
  reviewRound: number
  costTokens: number
  startedAt: string
  endedAt: string | null
}

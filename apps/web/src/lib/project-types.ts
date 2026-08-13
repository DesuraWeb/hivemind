import type { InboxType } from '@silithid/shared'

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
}

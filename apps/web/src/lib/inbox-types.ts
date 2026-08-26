import type { InboxStatus, InboxType } from '@silithid/shared'

/**
 * Forme rendue par `GET /api/inbox` (api/routes/inbox.ts, Task 4/7) : suit
 * `INBOX[]` de data.js, moins `age`/`ageMin` (calculés ici, cf. `age.ts`) et
 * plus `payload`/`archiveToClient` (contenu des panneaux, Task 7).
 */
export interface InboxItemView {
  id: string
  type: InboxType
  sub?: string
  title: string
  project: string | null
  agent: string | null
  /** Le run concerné, ou `null` sur une alerte système. Décide des actions proposées. */
  runId: string | null
  status: InboxStatus
  blockedSince: string
  createdAt: string
  payload: Record<string, unknown>
  archiveToClient: boolean
}

export interface ResolveResult {
  item: InboxItemView
  runResumed: boolean
}

/** Réponse humaine envoyée à `POST /api/inbox/:id/resolve` — forme libre au-delà de `text` (resolve.ts). */
export type InboxResponsePayload = Record<string, unknown> & { text?: string }

/**
 * Rendu par `POST /api/inbox/:id/optimize` (inbox/optimize.ts) : `optimized`
 * est une PROPOSITION, jamais écrite nulle part par cette route — c'est
 * QuestionPanel qui décide si elle remplace le champ (« Utiliser ») ou reste
 * simplement affichée. `added` liste ce que Hive a injecté que Florian
 * n'avait pas dit, pour que la proposition soit auditable.
 */
export interface OptimizeAnswerResult {
  optimized: string
  added: string[]
}

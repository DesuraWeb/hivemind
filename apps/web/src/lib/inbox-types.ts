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

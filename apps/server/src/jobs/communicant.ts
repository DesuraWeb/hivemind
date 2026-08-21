import type { Kysely } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { invoquerCommunicant } from '../communication/invoke'
import type { Database } from '../db/types'
import type { GmailDraftPort } from '../integrations/gmail'
import type { RuntimeAdapter } from '../runtime/types'

/**
 * Faire rédiger le communicant, hors du fil d'une requête HTTP.
 *
 * Le déclencheur est la résolution d'une mise en prod (`api/routes/inbox.ts`).
 * Le faire en ligne dans cette requête aurait fait attendre Florian derrière
 * un échange modèle complet — plusieurs dizaines de secondes — pour cliquer
 * « approuver ». Le geste qu'il vient de faire est terminé ; la rédaction qui
 * en découle ne le concerne plus tant qu'elle n'est pas prête.
 *
 * La route à la demande (`POST /api/projects/:slug/communicant`), elle, reste
 * synchrone : là, Florian a explicitement demandé un brouillon et attend de le
 * voir. Même arbitrage que `POST /api/inbox/:id/optimize`.
 */

export const COMMUNICANT_QUEUE = 'communicant.draft'

export interface CommunicantJobData {
  projectId: string
  sujet: string
  runId?: string | null
}

export interface CommunicantWorkerDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  drafts: GmailDraftPort
}

export async function registerCommunicantWorker(
  boss: PgBoss,
  deps: CommunicantWorkerDeps,
): Promise<void> {
  await boss.work<CommunicantJobData>(COMMUNICANT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await invoquerCommunicant({
        db: deps.db,
        adapter: deps.adapter,
        drafts: deps.drafts,
        projectId: job.data.projectId,
        sujet: job.data.sujet,
        runId: job.data.runId ?? null,
      })
    }
  })
}

import type { Kysely } from 'kysely'
import type { PgBoss } from 'pg-boss'
import type { Database } from '../db/types'
import { getInboxItem } from '../inbox/repo'
import { executerChangementApprouve } from '../ops/change-request'
import { lireServeur } from '../ops/probe'
import type { OpsExecutor } from '../ops/types'

/**
 * Appliquer un changement approuvé, hors du fil d'une requête HTTP.
 *
 * `apt-get install` sur un serveur lent prend une minute. Laisser la requête
 * de résolution d'inbox attendre ça la ferait expirer côté navigateur, et
 * Florian ne saurait pas si son changement est parti — l'incertitude la plus
 * désagréable de toutes sur une machine de production.
 *
 * Le résultat se lit ensuite dans l'item lui-même (`payload.applique`), et un
 * échec lève une alerte : la boucle se referme sans que personne n'attende
 * devant un écran.
 *
 * **Aucune reprise automatique** : `pg-boss` réessaierait un job échoué, et
 * rejouer une suite d'opérations à moitié appliquée sur un serveur de
 * production est exactement ce que `ops/apply.ts` refuse. Le worker absorbe
 * donc l'erreur — elle est déjà tracée en inbox par le module métier.
 */

export const OPS_APPLY_QUEUE = 'ops.apply'

export interface OpsApplyJobData {
  inboxItemId: string
}

export interface OpsApplyWorkerDeps {
  db: Kysely<Database>
  executor: OpsExecutor
}

export async function registerOpsApplyWorker(
  boss: PgBoss,
  deps: OpsApplyWorkerDeps,
): Promise<void> {
  await boss.work<OpsApplyJobData>(OPS_APPLY_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const item = await getInboxItem(deps.db, job.data.inboxItemId)
      if (!item) continue

      const serveurId = (item.payload.plan as { serveurId?: unknown } | undefined)?.serveurId
      if (typeof serveurId !== 'string') continue

      const serveur = await lireServeur(deps.db, serveurId)
      await executerChangementApprouve({ db: deps.db, executor: deps.executor, serveur }, item)
    }
  })
}

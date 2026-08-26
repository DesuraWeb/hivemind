import type { Kysely } from 'kysely'
import type { PgBoss } from 'pg-boss'
import type { Database } from '../db/types'
import { type AccesCible, lireCible } from '../deploy/cibles'
import { deployerEnProd } from '../deploy/prod'
import { createInboxItem, getInboxItem } from '../inbox/repo'
import { apprendreDuDeploiement } from '../ops/apprendre'
import type { OpsExecutor, SondeHttp } from '../ops/types'
import type { SettingsStore } from '../settings/store'

/**
 * La mise en production, une fois qu'un humain l'a approuvée.
 *
 * ## Enfilé, pas exécuté dans la requête
 *
 * Même raison que le changement d'exploitation : une sauvegarde, un
 * déploiement et une migration prennent plus qu'une requête HTTP, et faire
 * expirer celle de Florian le laisserait sans savoir si sa prod est partie —
 * l'incertitude la plus désagréable de toutes sur un site vivant.
 *
 * ## Ce qui reste dans l'item
 *
 * Le résultat s'écrit dans `payload.mise_en_prod` : les étapes tentées, dans
 * l'ordre, avec leur détail. Un échec y est lisible sans ouvrir un log de
 * serveur — c'est la règle de Florian, apprendre un échec depuis l'écran.
 */

export const PROD_DEPLOY_QUEUE = 'prod.deploy'

export interface ProdDeployJobData {
  inboxItemId: string
}

export interface ProdDeployWorkerDeps {
  db: Kysely<Database>
  settings: SettingsStore
  executor: OpsExecutor
  http: SondeHttp
  /** Pousse le code sur la cible. Injecté pour que le job reste testable sans SSH ni git. */
  poserLeCode: (
    acces: AccesCible,
    ctx: { runId: string | null; projectSlug: string },
  ) => Promise<{ ok: boolean; detail: string }>
  horodater: () => string
}

/**
 * Les fichiers de migration relevés par le gate, tels qu'il les a écrits.
 *
 * Relus depuis le payload et jamais recalculés : ce qui part en prod doit être
 * exactement ce qui a été MONTRÉ à l'approbation. Recalculer ouvrirait la
 * porte à un écart entre ce que Florian a validé et ce qui s'exécute.
 */
function migrationsDeLItem(payload: Record<string, unknown>): string[] {
  const prod = payload.prod as { migrations?: unknown } | undefined
  return Array.isArray(prod?.migrations) ? prod.migrations.filter((m) => typeof m === 'string') : []
}

export async function registerProdDeployWorker(
  boss: PgBoss,
  deps: ProdDeployWorkerDeps,
): Promise<void> {
  await boss.work<ProdDeployJobData>(PROD_DEPLOY_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const item = await getInboxItem(deps.db, job.data.inboxItemId)
      if (!item?.projectId) continue

      const projet = await deps.db
        .selectFrom('projects')
        .select(['stack', 'name', 'slug'])
        .where('id', '=', item.projectId)
        .executeTakeFirst()

      const resultat = await deployerEnProd(
        {
          db: deps.db,
          settings: deps.settings,
          executor: deps.executor,
          http: deps.http,
          poserLeCode: deps.poserLeCode,
        },
        {
          projectId: item.projectId,
          migrations: migrationsDeLItem(item.payload),
          horodatage: deps.horodater(),
          runId: item.runId,
          projectSlug: projet?.slug ?? '',
        },
      )

      await deps.db
        .updateTable('inbox_items')
        .set({
          payload: JSON.stringify({
            ...item.payload,
            mise_en_prod: {
              ok: resultat.ok,
              etapes: resultat.etapes,
              url: resultat.url,
              restaure: resultat.restaure,
              ...(resultat.raison ? { raison: resultat.raison } : {}),
            },
          }),
        })
        .where('id', '=', item.id)
        .execute()

      if (!resultat.ok) {
        // Une alerte, pas une ligne de log. Un humain a décidé qu'un site
        // devait changer et ça s'est mal passé sur du vivant : c'est le cas
        // qui doit remonter à l'écran, pas celui qu'on retrouve en fouillant.
        await createInboxItem(deps.db, {
          type: 'alert',
          projectId: item.projectId,
          runId: item.runId,
          fromRole: 'system',
          title: `Mise en prod échouée · ${projet?.name ?? 'projet'}`,
          payload: {
            cause: 'prod.deploiement_echoue',
            ctx: resultat.raison ?? 'échec sans raison rendue',
            etapes: resultat.etapes,
            // Dit explicitement, parce que c'est la première question qu'on se
            // pose : la base a-t-elle été remise en état ?
            restaure: resultat.restaure,
          },
        })
      }

      // Lot F · ce qu'une mise en prod apprend. Seuls les échecs remontent : un
      // déploiement réussi n'apprend rien qu'on ne sache déjà.
      const cible = await lireCible(deps.db, item.projectId, 'prod')
      await apprendreDuDeploiement(
        {
          db: deps.db,
          projectId: item.projectId,
          stack: projet?.stack ?? null,
          // Le NIVEAU auquel ce qu'on vient d'apprendre est vrai. Sans lui, «
          // la migration casse ici » serait rappelée sur tous les hébergements.
          ...(cible ? { hebergement: cible.typeHebergement } : {}),
          runId: item.runId,
        },
        resultat,
      )
    }
  })
}

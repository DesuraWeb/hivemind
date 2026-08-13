import type { Kysely } from 'kysely'
import { PgBoss } from 'pg-boss'
import type { Database } from '../db/types'
import { type Env, databaseUrl } from '../env'
import { runAuthHealthcheck } from '../health/auth-check'
import type { Mailer } from '../integrations/mailer'
import type { RuntimeAdapter } from '../runtime/types'
import { RUN_STEP_QUEUE, type StepRegistry, registerRunStepWorker } from './run-step'

/** Brief §4 : le healthcheck d'authentification tourne toutes les 15 minutes. */
export const AUTH_HEALTHCHECK_QUEUE = 'auth.healthcheck'
const AUTH_HEALTHCHECK_CRON = '*/15 * * * *'

export interface BossDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  mailer: Mailer
  alertTo: string
  /**
   * Handlers de step à câbler sur le worker `run.step`. `index.ts` passe le
   * registre réel (`../loop/registry.ts`, Task 5, Phase 4) ; omis, `{}` reste
   * le défaut ci-dessous — c'est ce que gardent les tests qui n'exercent pas
   * la boucle elle-même, et ce que remplissent ceux qui le font.
   */
  stepRegistry?: StepRegistry
}

/**
 * Construit l'instance pg-boss, sans la démarrer. pg-boss vit dans son propre
 * schéma Postgres (`pgboss` par défaut, distinct de `public`) : il n'entre
 * jamais en conflit avec les migrations applicatives ni avec le
 * `drop schema public cascade` que la suite de tests exécute avant chaque
 * fichier.
 */
export function createBoss(env: Env): PgBoss {
  return new PgBoss({ connectionString: databaseUrl(env) })
}

/**
 * Démarre pg-boss, déclare les queues, câble le worker `run.step` et le cron
 * du healthcheck d'authentification (brief §4), maintenant que l'infra de
 * file existe.
 */
export async function startBoss(boss: PgBoss, deps: BossDeps): Promise<void> {
  await boss.start()

  await boss.createQueue(RUN_STEP_QUEUE)
  await registerRunStepWorker(boss, deps.db, deps.stepRegistry ?? {})

  await boss.createQueue(AUTH_HEALTHCHECK_QUEUE)
  await boss.work(AUTH_HEALTHCHECK_QUEUE, async () => {
    await runAuthHealthcheck({
      db: deps.db,
      adapter: deps.adapter,
      mailer: deps.mailer,
      alertTo: deps.alertTo,
    })
  })
  // Une seule planification pour ce nom de queue : `schedule` est idempotent
  // côté pg-boss (upsert sur la clé de queue), un redémarrage ne duplique pas
  // le cron.
  await boss.schedule(AUTH_HEALTHCHECK_QUEUE, AUTH_HEALTHCHECK_CRON)
}

import { sql } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { createMailer } from '../src/integrations/mailer'
import { AUTH_HEALTHCHECK_QUEUE, BUDGET_PROBE_QUEUE, createBoss, startBoss } from '../src/jobs/boss'
import { RUN_STEP_QUEUE } from '../src/jobs/run-step'
import { createFakeAdapter } from '../src/runtime/fake'

// La sonde de budget ne lit que des clés publiques : un stub suffit ici, ces
// deux tests ne portent que sur les queues et les crons.
const settings = { get: async () => undefined }

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
afterAll(async () => {
  await db.destroy()
})

// pg-boss vit dans son propre schéma (`pgboss`, distinct de `public`) : le
// `drop schema public cascade` des autres fichiers de test ne le touche
// jamais. Vérifié ici plutôt que supposé — cf. `plans.js` de pg-boss,
// `DEFAULT_SCHEMA = 'pgboss'`.
test('demarre, cree les queues, planifie les crons, et s arrete proprement', async () => {
  const boss = createBoss(env)
  const mailer = createMailer(env)
  const adapter = createFakeAdapter()

  await startBoss(boss, { db, adapter, mailer, alertTo: 'alerts@exemple.test', settings })

  try {
    const queues = await boss.getQueues([
      RUN_STEP_QUEUE,
      AUTH_HEALTHCHECK_QUEUE,
      BUDGET_PROBE_QUEUE,
    ])
    expect(queues.map((q) => q.name).sort()).toEqual(
      [AUTH_HEALTHCHECK_QUEUE, BUDGET_PROBE_QUEUE, RUN_STEP_QUEUE].sort(),
    )

    const schedules = await boss.getSchedules(AUTH_HEALTHCHECK_QUEUE)
    expect(schedules).toHaveLength(1)
    expect(schedules[0]?.cron).toBe('*/15 * * * *')

    const budgetSchedules = await boss.getSchedules(BUDGET_PROBE_QUEUE)
    expect(budgetSchedules).toHaveLength(1)
    expect(budgetSchedules[0]?.cron).toBe('*/5 * * * *')

    const tables = await sql<{ schema: string }>`
      select schemaname as schema from pg_tables where tablename = 'job'
    `.execute(db)
    expect(tables.rows.map((r) => r.schema)).toContain('pgboss')
    expect(tables.rows.map((r) => r.schema)).not.toContain('public')
  } finally {
    await boss.stop()
  }
})

test('demarrer un second boss puis l arreter ne laisse rien en travers (redemarrage propre)', async () => {
  const boss: PgBoss = createBoss(env)
  const mailer = createMailer(env)
  const adapter = createFakeAdapter()

  await startBoss(boss, { db, adapter, mailer, alertTo: 'alerts@exemple.test', settings })
  // Deux appels createQueue/schedule sur les mêmes noms (déjà créés par le
  // test précédent) : idempotent, ne doit pas lever.
  await boss.stop()
})

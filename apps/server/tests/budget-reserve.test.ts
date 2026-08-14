import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import {
  DEFAULT_UNLOCK_MINUTES,
  MAX_UNLOCK_MINUTES,
  clampUnlockMinutes,
  effectivePauseThreshold,
  parseUnlockUntil,
} from '../src/budget/reserve'
import { DEFAULT_BUDGET_THRESHOLDS, decideBudget } from '../src/budget/scheduler'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { createBoss } from '../src/jobs/boss'
import { RUN_STEP_QUEUE } from '../src/jobs/run-step'
import type { UsageSnapshot } from '../src/runtime/types'
import { stopBoss } from './stop-boss'

/**
 * Le déblocage de la réserve. Aucun token : `usage()` est simulée, et les
 * fonctions de décision sont pures.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const boss: PgBoss = createBoss(env)

/** Jauge à 92 % : au-dessus du seuil de pause (85 %), sous le plafond absolu. */
const GAUGE_92: UsageSnapshot = {
  fiveHourPct: 92,
  sevenDayPct: 40,
  available: true,
  sampledAt: new Date(),
}

const app = await buildApp({ db, boss, adapter: { usage: async () => GAUGE_92 } as never })

let cookie: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await createUser(db, 'florian', 'motdepasse-de-test')
  await boss.start()
  await boss.createQueue(RUN_STEP_QUEUE)
  await app.ready()

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  cookie = login.cookies.find((c) => c.name === 'hm_session')?.value as string
})

afterAll(async () => {
  await app.close()
  await stopBoss(boss)
  await db.destroy()
})

// ── Les fonctions pures ───────────────────────────────────────────────────

test('une échéance passée rend la réserve intacte, sans que personne ait à refermer', () => {
  const now = new Date('2026-08-13T15:00:00Z')
  expect(parseUnlockUntil('2026-08-13T14:30:00Z', now)).toEqual({ state: 'intacte' })
  expect(parseUnlockUntil('2026-08-13T15:30:00Z', now).state).toBe('entamee')
})

test('une valeur de réglage illisible ne débloque rien', () => {
  const now = new Date()
  // Le réglage accepte n'importe quel JSON : lui faire confiance ouvrirait la
  // réserve sur une faute de frappe.
  for (const bogus of ['', 'demain', 42, null, undefined, {}, []]) {
    expect(parseUnlockUntil(bogus, now)).toEqual({ state: 'intacte' })
  }
})

test('réserve entamée : plus de seuil de pause', () => {
  expect(effectivePauseThreshold(DEFAULT_BUDGET_THRESHOLDS, { state: 'intacte' })).toBe(85)
  expect(
    effectivePauseThreshold(DEFAULT_BUDGET_THRESHOLDS, {
      state: 'entamee',
      until: new Date(Date.now() + 60_000),
    }),
  ).toBe(100)
})

test('la durée est bornée à deux heures, une valeur absurde retombe sur le défaut', () => {
  expect(clampUnlockMinutes(45)).toBe(45)
  expect(clampUnlockMinutes(9999)).toBe(MAX_UNLOCK_MINUTES)
  expect(clampUnlockMinutes(0)).toBe(DEFAULT_UNLOCK_MINUTES)
  expect(clampUnlockMinutes(-5)).toBe(DEFAULT_UNLOCK_MINUTES)
  expect(clampUnlockMinutes('beaucoup')).toBe(DEFAULT_UNLOCK_MINUTES)
  expect(clampUnlockMinutes(Number.NaN)).toBe(DEFAULT_UNLOCK_MINUTES)
})

test('le tick ne remet PAS en pause tant que la réserve est entamée — sinon la reprise ne durerait pas 5 minutes', () => {
  const now = new Date()
  const intacte = decideBudget(GAUGE_92, DEFAULT_BUDGET_THRESHOLDS, now, { state: 'intacte' })
  expect(intacte.action).toBe('pause')

  const entamee = decideBudget(GAUGE_92, DEFAULT_BUDGET_THRESHOLDS, now, {
    state: 'entamee',
    until: new Date(now.getTime() + 60_000),
  })
  // Ni pause (c'est le but), ni reprise parasite : 92 % reste au-dessus du
  // seuil de reprise, il n'y a rien à faire repartir de plus.
  expect(entamee.action).toBe('none')
})

// ── La route ──────────────────────────────────────────────────────────────

async function seedPausedRun(): Promise<string> {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe Réserve', slug: `globe-reserve-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Projet Réserve',
      slug: `projet-reserve-${randomUUID()}`,
      repo_full_name: 'DesuraWeb/silithid-sandbox',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'Step réserve', specs: '## Specs' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id, state: 'paused_budget', resume_state: 'coding' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return run.id
}

test('GET /api/budget rend la jauge et l état de la réserve', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/budget',
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.gauge.pct).toBe(92)
  expect(body.reserve.state).toBe('intacte')
  expect(body.thresholds.pause).toBe(85)
})

test('débloquer la réserve fait repartir les runs en pause ET lève le seuil', async () => {
  const runId = await seedPausedRun()

  const res = await app.inject({
    method: 'POST',
    url: '/api/budget/reserve/unlock',
    cookies: { hm_session: cookie },
    payload: { minutes: 45 },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.minutes).toBe(45)
  expect(body.resumed).toContain(runId)
  expect(body.skipped).toEqual([])

  // Le run est réellement reparti en base, pas seulement annoncé.
  const run = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(run.state).toBe('coding')

  // Et le seuil est levé : sans ça le tick suivant annulerait tout.
  const after = await app.inject({
    method: 'GET',
    url: '/api/budget',
    cookies: { hm_session: cookie },
  })
  expect(after.json().reserve.state).toBe('entamee')
  expect(after.json().thresholds.pause).toBe(100)
  // Le seuil nominal reste affiché à côté : « 85 %, dérogation en cours » se
  // lit, « 100 % » tout seul ne se lit pas.
  expect(after.json().thresholds.pauseNominal).toBe(85)
})

test('refermer la réserve rétablit le seuil', async () => {
  await app.inject({
    method: 'POST',
    url: '/api/budget/reserve/lock',
    cookies: { hm_session: cookie },
  })

  const res = await app.inject({
    method: 'GET',
    url: '/api/budget',
    cookies: { hm_session: cookie },
  })
  expect(res.json().reserve.state).toBe('intacte')
  expect(res.json().thresholds.pause).toBe(85)
})

test('la route exige une session', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/budget/reserve/unlock' })
  expect(res.statusCode).toBe(401)
})

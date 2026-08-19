import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { ensureGlobe } from './fixtures'

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const app = await buildApp({ db })

let cookie: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await createUser(db, 'florian', 'motdepasse-de-test')
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
  await db.destroy()
})

function get(url: string) {
  return app.inject({ method: 'GET', url, cookies: { hm_session: cookie } })
}

interface RunSpec {
  tokens: number
  /** Ancienneté en jours du `started_at`. 0 = aujourd'hui. */
  daysAgo: number
  done?: boolean
  stepPosition?: number
}

async function seedProject(name: string, runs: RunSpec[]): Promise<string> {
  const globe = await ensureGlobe(db)
  const slug = `analytics-${randomUUID()}`
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name,
      slug,
      repo_full_name: 'desura/x',
      tint: '#7FD9CF',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const steps: string[] = []
  for (let i = 1; i <= 3; i++) {
    const s = await db
      .insertInto('steps')
      .values({ project_id: project.id, position: i, title: `Step ${i}`, specs: '## s' })
      .returning('id')
      .executeTakeFirstOrThrow()
    steps.push(s.id)
  }

  for (const run of runs) {
    const stepId = steps[(run.stepPosition ?? 1) - 1]
    const inserted = await db
      .insertInto('runs')
      .values({
        step_id: stepId as string,
        state: run.done ? 'done' : 'coding',
        cost_tokens: String(run.tokens),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const at = new Date(Date.now() - run.daysAgo * 86_400_000)
    await sql`update runs set started_at = ${at} where id = ${inserted.id}`.execute(db)
  }
  return slug
}

test('GET /api/analytics sans cookie renvoie 401', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/analytics' })).statusCode).toBe(401)
})

test('la série quotidienne a un point par jour, même les jours sans activité', async () => {
  await seedProject('Projet série', [{ tokens: 1000, daysAgo: 0 }])

  const body = (await get('/api/analytics?days=7')).json()
  // Sept jours, sept points : sans les jours à zéro, les barres se
  // resserreraient sur les jours actifs et un week-end creux disparaîtrait.
  expect(body.daily).toHaveLength(7)
  expect(body.daily.filter((d: { tokens: number }) => d.tokens === 0).length).toBe(6)
  // Le dernier point est aujourd'hui.
  expect(body.daily[6].day).toBe(new Date().toISOString().slice(0, 10))
})

test('un run hors de la fenêtre ne compte pas', async () => {
  await seedProject('Projet vieux', [
    { tokens: 5000, daysAgo: 1 },
    // 40 jours : hors d'une fenêtre de 7, dans une fenêtre de 90.
    { tokens: 9000, daysAgo: 40 },
  ])

  const court = (await get('/api/analytics?days=7')).json()
  const long = (await get('/api/analytics?days=90')).json()
  expect(long.totalTokens - court.totalTokens).toBe(9000)
})

test('le coût par projet est trié par consommation, avec les steps validés', async () => {
  const gros = await seedProject('Gros', [
    { tokens: 100_000, daysAgo: 1, done: true },
    { tokens: 50_000, daysAgo: 2 },
  ])
  const petit = await seedProject('Petit', [{ tokens: 1000, daysAgo: 1 }])

  const body = (await get('/api/analytics?days=30')).json()
  const ids = body.perProject.map((p: { id: string }) => p.id)
  expect(ids.indexOf(gros)).toBeLessThan(ids.indexOf(petit))

  const g = body.perProject.find((p: { id: string }) => p.id === gros)
  expect(g.tokens).toBe(150_000)
  // 150 k tokens à 15 €/Mtok (repli, settings absent en base de test) = 2,25 €.
  expect(g.eur).toBe(2.25)
  // Un seul run terminé sur les deux : c'est ce rapprochement coût/valeur qui
  // rend l'écran utile.
  expect(g.stepsDone).toBe(1)
  expect(body.perProject.find((p: { id: string }) => p.id === petit).stepsDone).toBe(0)
})

test('un step sans aucun run apparaît à zéro plutôt que de disparaître', async () => {
  const slug = await seedProject('Steps', [
    { tokens: 20_000, daysAgo: 1, stepPosition: 1 },
    { tokens: 40_000, daysAgo: 1, stepPosition: 3 },
  ])

  const body = (await get(`/api/analytics/steps/${slug}`)).json()
  expect(body).toHaveLength(3)
  expect(body[0]).toMatchObject({ position: 1, tokens: 20_000 })
  // Le step 2 n'a jamais été lancé : c'est une information, pas une absence.
  expect(body[1]).toMatchObject({ position: 2, tokens: 0, eur: 0 })
  expect(body[2]).toMatchObject({ position: 3, tokens: 40_000 })
})

test('une fenêtre absurde est refusée, pas ramenée au défaut en silence', async () => {
  // Sinon l'appelant croirait lire 400 jours et en lirait 30.
  expect((await get('/api/analytics?days=400')).statusCode).toBe(400)
  expect((await get('/api/analytics?days=0')).statusCode).toBe(400)
  expect((await get('/api/analytics?days=abc')).statusCode).toBe(400)
})

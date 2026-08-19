import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { appendMessage } from '../src/loop/bus'
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

async function seedRun(): Promise<string> {
  const globe = await ensureGlobe(db)
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Projet Run',
      slug: `projet-run-${randomUUID()}`,
      repo_full_name: 'desura/x',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 2, title: 'Fiche etablissement', specs: '## s' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({
      step_id: step.id,
      state: 'reviewing',
      iteration: 2,
      cost_tokens: '31200',
      branch: 'run/abc',
      pr_number: 12,
      worktree_path: '/Users/desura/secret/chemin/local',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return run.id
}

test('GET /api/runs/:id sans cookie renvoie 401', async () => {
  expect((await app.inject({ method: 'GET', url: `/api/runs/${randomUUID()}` })).statusCode).toBe(
    401,
  )
})

test('un identifiant mal forme est un 400 lisible, pas une erreur Postgres en 500', async () => {
  expect((await get('/api/runs/pas-un-uuid')).statusCode).toBe(400)
})

test('un run inconnu renvoie 404', async () => {
  expect((await get(`/api/runs/${randomUUID()}`)).statusCode).toBe(404)
})

test('le detail porte le pipeline, le cout et la timeline des passations', async () => {
  const runId = await seedRun()
  await appendMessage(db, {
    runId,
    fromRole: 'garant',
    toRole: 'dev',
    kind: 'prompt',
    body: 'Cadrage du step.',
    meta: { acceptance_criteria: ['un critere'] },
  })
  await appendMessage(db, {
    runId,
    fromRole: 'dev',
    toRole: 'garant',
    kind: 'report',
    body: 'PR ouverte.',
  })

  const body = (await get(`/api/runs/${runId}`)).json()

  expect(body.state).toBe('reviewing')
  expect(body.step).toEqual({ position: 2, title: 'Fiche etablissement' })
  expect(body.iteration).toEqual([2, 4])
  expect(body.costTokens).toBe(31_200)
  expect(body.prNumber).toBe(12)

  // La timeline est dans l'ordre chronologique : c'est une piste d'audit,
  // elle se lit du debut vers la fin.
  expect(body.timeline).toHaveLength(2)
  expect(body.timeline[0].fromRole).toBe('garant')
  expect(body.timeline[1].fromRole).toBe('dev')
  expect(body.timeline[0].meta.acceptance_criteria).toEqual(['un critere'])

  // Run en cours : pas de chrono fige a l'instant de la requete, c'est au
  // front d'animer depuis startedAt.
  expect(body.durationSeconds).toBeNull()
})

test('le chemin du worktree ne sort JAMAIS de l API', async () => {
  const runId = await seedRun()
  const res = await get(`/api/runs/${runId}`)
  // Cherche dans le corps serialise entier : une fuite par un champ oublie
  // doit faire echouer ce test.
  expect(res.body).not.toContain('/Users/desura/secret/chemin/local')
  expect(res.body).not.toContain('worktree')
})

test('un run termine porte sa duree', async () => {
  const runId = await seedRun()
  await sql`update runs set started_at = now() - interval '5 minutes', ended_at = now(), state = 'done' where id = ${runId}`.execute(
    db,
  )

  const body = (await get(`/api/runs/${runId}`)).json()
  expect(body.durationSeconds).toBeGreaterThanOrEqual(299)
  expect(body.durationSeconds).toBeLessThanOrEqual(301)
})

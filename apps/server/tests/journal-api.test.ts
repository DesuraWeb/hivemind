import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { createInboxItem } from '../src/inbox/repo'
import { appendMessage } from '../src/loop/bus'

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

async function seed(): Promise<{ projectId: string; runId: string }> {
  const globe = await db.selectFrom('globes').select('id').executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Projet Journal',
      slug: `journal-${randomUUID()}`,
      repo_full_name: 'desura/x',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'Step', specs: '## s' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id, state: 'coding' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { projectId: project.id, runId: run.id }
}

test('GET /api/journal sans cookie renvoie 401', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/journal' })).statusCode).toBe(401)
})

test('la nuit rend les passations d agents, la plus recente en tete', async () => {
  const { runId } = await seed()
  await appendMessage(db, {
    runId,
    fromRole: 'garant',
    toRole: 'dev',
    kind: 'prompt',
    body: 'Cadrage.',
  })
  await appendMessage(db, {
    runId,
    fromRole: 'dev',
    toRole: 'reviewer',
    kind: 'report',
    body: 'PR ouverte.',
  })

  const body = (await get('/api/journal')).json()
  expect(body.night).toHaveLength(2)
  // La plus recente en tete : on lit un journal du present vers le passe.
  expect(body.night[0].role).toBe('dev')
  expect(body.night[1].role).toBe('garant')
  expect(body.night[0].runId).toBe(runId)
  expect(body.retentionDays).toBe(90)
})

test('un item encore ouvert n est pas une decision, un item ecarte en est une', async () => {
  const { projectId } = await seed()
  await createInboxItem(db, { type: 'question', title: 'Jamais repondue', projectId })
  const tranche = await createInboxItem(db, {
    type: 'approval',
    subtype: 'prod',
    title: 'Mise en prod du step 1',
    projectId,
  })
  // Resolution ecrite directement : `resolveInboxItem` exige un pg-boss et
  // declenche la reprise du run, ce qui n'a rien a voir avec ce que le journal
  // lit. Ici on teste la lecture, pas la resolution.
  await db
    .updateTable('inbox_items')
    .set({
      status: 'done',
      human_response: JSON.stringify({ approved: true, note: 'go' }),
      resolved_at: new Date(),
    })
    .where('id', '=', tranche.id)
    .execute()

  const body = (await get('/api/journal')).json()
  const titres = body.decisions.map((d: { title: string }) => d.title)
  expect(titres).toContain('Mise en prod du step 1')
  // Un item non tranche n'a rien a faire dans le journal des decisions.
  expect(titres).not.toContain('Jamais repondue')

  const prod = body.decisions.find((d: { title: string }) => d.title.startsWith('Mise en prod'))
  expect(prod.kind).toBe('approval')
  expect(prod.subtype).toBe('prod')
  expect(prod.response).toMatchObject({ approved: true })
  // La revocation n'est pas implementee : le dire plutot que d'afficher un
  // bouton qui ne ferait rien.
  expect(prod.revocable).toBe(false)
})

test('une fenetre au-dela de la retention est refusee, pas ramenee au defaut', async () => {
  // 90 jours = 2160 heures, la retention annoncee par l'ecran.
  expect((await get('/api/journal?hours=2160')).statusCode).toBe(200)
  expect((await get('/api/journal?hours=2161')).statusCode).toBe(400)
  expect((await get('/api/journal?hours=0')).statusCode).toBe(400)
})

test('la fenetre borne reellement : un message trop vieux sort du journal', async () => {
  const { runId } = await seed()
  await appendMessage(db, {
    runId,
    fromRole: 'garant',
    toRole: 'dev',
    kind: 'prompt',
    body: 'Vieux message.',
  })
  // `appendMessage` ne rend pas la ligne ecrite : on la retrouve par son run.
  const msg = await db
    .selectFrom('messages')
    .select('id')
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()
  await sql`update messages set created_at = now() - interval '48 hours' where id = ${msg.id}`.execute(
    db,
  )

  const court = (await get('/api/journal?hours=24')).json()
  const long = (await get('/api/journal?hours=72')).json()
  expect(court.night.map((n: { id: string }) => n.id)).not.toContain(msg.id)
  expect(long.night.map((n: { id: string }) => n.id)).toContain(msg.id)
})

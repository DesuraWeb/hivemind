import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { createInboxItem } from '../src/inbox/repo'

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

function post(url: string, payload: Record<string, unknown>, withCookie = true) {
  return app.inject({
    method: 'POST',
    url,
    payload,
    ...(withCookie ? { cookies: { hm_session: cookie } } : {}),
  })
}

async function createProject(
  globeId: string,
  opts: { withRun?: 'run' | 'done'; slug?: string } = {},
) {
  const slug = opts.slug ?? `p-globes-api-${randomUUID()}`
  const project = await db
    .insertInto('projects')
    .values({ globe_id: globeId, name: 'P', slug, repo_full_name: 'a/b' })
    .returning('id')
    .executeTakeFirstOrThrow()
  if (opts.withRun) {
    const step = await db
      .insertInto('steps')
      .values({ project_id: project.id, position: 1, title: 'T', specs: '## S' })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('runs')
      .values({ step_id: step.id, state: opts.withRun === 'run' ? 'coding' : 'done' })
      .execute()
  }
  return project.id
}

// --- Authentification ---

test('GET /api/globes sans cookie renvoie 401', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/globes' })).statusCode).toBe(401)
})

test('POST /api/globes sans cookie renvoie 401', async () => {
  expect((await post('/api/globes', { name: 'X' }, false)).statusCode).toBe(401)
})

// --- Liste ---

test('GET /api/globes rend une liste vide sur une installation neuve', async () => {
  const res = await get('/api/globes')
  expect(res.statusCode).toBe(200)
  // Aucun globe seedé (migration 0006) : c'est un état normal, pas une panne.
  // L'écran Globes doit inviter à en créer un, pas afficher une erreur.
  expect(res.json()).toEqual([])
})

// --- Agrégats dérivés, pas fabriqués ---

test('GET /api/globes compte les projets, les boucles actives et les items ouverts', async () => {
  const globe = await db
    .insertInto('globes')
    .values({ name: `Aggreg ${randomUUID()}`, slug: `aggreg-${randomUUID()}` })
    .returning(['id', 'slug'])
    .executeTakeFirstOrThrow()

  const p1 = await createProject(globe.id, { withRun: 'run' })
  await createProject(globe.id, { withRun: 'done' })
  await createInboxItem(db, { type: 'question', title: 'Q', projectId: p1 })
  await createInboxItem(db, { type: 'alert', title: 'A', projectId: p1 })

  const body = (await get('/api/globes')).json() as Array<{
    id: string
    projectCount: number
    activeCount: number
    pendingCount: number
  }>
  const g = body.find((x) => x.id === globe.slug)
  expect(g).toMatchObject({ projectCount: 2, activeCount: 1, pendingCount: 2 })
})

test('un globe sans aucun projet rend des compteurs a zero', async () => {
  const globe = await db
    .insertInto('globes')
    .values({ name: `Vide ${randomUUID()}`, slug: `vide-${randomUUID()}` })
    .returning('slug')
    .executeTakeFirstOrThrow()

  const body = (await get('/api/globes')).json() as Array<{
    id: string
    projectCount: number
    activeCount: number
    pendingCount: number
  }>
  const g = body.find((x) => x.id === globe.slug)
  expect(g).toMatchObject({ projectCount: 0, activeCount: 0, pendingCount: 0 })
})

// --- Création ---

test('POST /api/globes cree un globe et derive son slug du nom', async () => {
  const res = await post('/api/globes', {
    name: `R&D ${randomUUID().slice(0, 8)}`,
    color: '#7FB8E8',
  })
  expect(res.statusCode).toBe(201)
  const body = res.json()
  expect(body.name).toMatch(/^R&D /)
  expect(body.color).toBe('#7FB8E8')
  expect(body.id).toMatch(/^r-d-/)
  expect(body.projectCount).toBe(0)
})

test('POST /api/globes desambiguise le slug en cas de collision de nom', async () => {
  const name = `Doublon ${randomUUID().slice(0, 8)}`
  const first = (await post('/api/globes', { name })).json()
  const second = (await post('/api/globes', { name })).json()
  expect(first.id).not.toBe(second.id)
  expect(second.id).toBe(`${first.id}-2`)
})

test('POST /api/globes refuse un nom vide', async () => {
  expect((await post('/api/globes', { name: '  ' })).statusCode).toBe(400)
})

test('POST /api/globes sans couleur : color est null', async () => {
  const res = await post('/api/globes', { name: `Sans couleur ${randomUUID().slice(0, 8)}` })
  expect(res.json().color).toBeNull()
})

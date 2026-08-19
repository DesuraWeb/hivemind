import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedDefaultSettings, seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { type CreateInboxItemInput, createInboxItem } from '../src/inbox/repo'
import { createBoss } from '../src/jobs/boss'
import { type FakeToolCall, createFakeAdapter } from '../src/runtime/fake'
import { ensureGlobe } from './fixtures'

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
// Jamais démarré : la route `optimize` (contrairement à `resolve`) n'enfile
// aucun job pg-boss, `boss` n'est ici qu'une dépendance obligatoire de `buildApp`.
const boss: PgBoss = createBoss(env)

let cookie: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await seedRoleTemplates(db)
  await seedDefaultSettings(db)
  await createUser(db, 'florian', 'motdepasse-de-test')

  // Un seul login, réutilisable sur n'importe quelle instance `buildApp` de ce
  // fichier : le cookie signé (session.ts) ne porte que l'id utilisateur,
  // vérifié contre `db` — pas d'état en mémoire propre à une instance Fastify.
  const loginApp = await buildApp({ db, boss, adapter: createFakeAdapter() })
  await loginApp.ready()
  const res = await loginApp.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  cookie = res.cookies.find((c) => c.name === 'hm_session')?.value as string
  await loginApp.close()
})

afterAll(async () => {
  await db.destroy()
})

/** Une instance `buildApp` scriptée avec le `FakeAdapter` du test — jamais de tokens réels consommés. */
async function appWithReplies(replies: (string | FakeToolCall)[]) {
  const app = await buildApp({ db, boss, adapter: createFakeAdapter({ replies }) })
  await app.ready()
  return app
}

async function createProject(): Promise<{ projectId: string }> {
  const globe = await ensureGlobe(db)
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'P',
      slug: `p-optimize-${randomUUID()}`,
      repo_full_name: 'a/b',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { projectId: project.id }
}

function makeQuestion(overrides: Partial<CreateInboxItemInput> = {}): CreateInboxItemInput {
  return { type: 'question', title: 'On passe la home en dark mode ?', ...overrides }
}

const validPayload = {
  optimized:
    'Oui, réalise la home en dark mode. Mobile 390px en premier, tokens du pack, un test qui couvre le rendu.',
  added: ['viewport mobile 390 en premier', 'test qui couvre le rendu livré'],
}

// --- Authentification ---

test('POST /api/inbox/:id/optimize sans cookie renvoie 401', async () => {
  const app = await appWithReplies([])
  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${randomUUID()}/optimize`,
    payload: { text: 'x' },
  })
  expect(res.statusCode).toBe(401)
  await app.close()
})

// --- Validation de la requête ---

test('POST /api/inbox/:id/optimize avec un id non-uuid renvoie 400', async () => {
  const app = await appWithReplies([])
  const res = await app.inject({
    method: 'POST',
    url: '/api/inbox/pas-un-uuid/optimize',
    payload: { text: 'x' },
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(400)
  await app.close()
})

test('POST /api/inbox/:id/optimize avec un texte vide renvoie 400', async () => {
  const { projectId } = await createProject()
  const item = await createInboxItem(db, makeQuestion({ projectId }))
  const app = await appWithReplies([])

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/optimize`,
    payload: { text: '' },
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(400)
  await app.close()
})

test('POST /api/inbox/:id/optimize sur un id inconnu renvoie 404', async () => {
  const app = await appWithReplies([])
  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${randomUUID()}/optimize`,
    payload: { text: 'ok' },
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(404)
  await app.close()
})

test('POST /api/inbox/:id/optimize sur un item qui n est pas une question renvoie 400', async () => {
  const { projectId } = await createProject()
  const item = await createInboxItem(db, { type: 'alert', title: 'Alerte', projectId })
  const app = await appWithReplies([])

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/optimize`,
    payload: { text: 'ok' },
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(400)
  expect(res.json()).toEqual({ error: 'type_non_supporte' })
  await app.close()
})

test('POST /api/inbox/:id/optimize sur une question sans projet renvoie 422', async () => {
  const item = await createInboxItem(db, makeQuestion({ projectId: null }))
  const app = await appWithReplies([])

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/optimize`,
    payload: { text: 'ok' },
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(422)
  await app.close()
})

// --- Sortie structurée : appel d'outil direct, retry, échec ---

test('proposition valide dès le premier échange : 200, forme { optimized, added }, un seul appel modèle', async () => {
  const { projectId } = await createProject()
  const item = await createInboxItem(db, makeQuestion({ projectId }))
  const app = await appWithReplies([
    { toolUse: { name: 'submit_optimized_answer', input: validPayload } },
  ])

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/optimize`,
    payload: { text: 'oui vas-y' },
    cookies: { hm_session: cookie },
  })

  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual(validPayload)
  await app.close()
})

test('texte libre puis appel d outil valide : la route retente et aboutit', async () => {
  const { projectId } = await createProject()
  const item = await createInboxItem(db, makeQuestion({ projectId }))
  const app = await appWithReplies([
    "voici ma réponse en prose, sans appeler d'outil",
    { toolUse: { name: 'submit_optimized_answer', input: validPayload } },
  ])

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/optimize`,
    payload: { text: 'oui vas-y' },
    cookies: { hm_session: cookie },
  })

  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual(validPayload)
  await app.close()
})

test('texte libre systématique : 502 après épuisement des tentatives, jamais une 500 opaque', async () => {
  const { projectId } = await createProject()
  const item = await createInboxItem(db, makeQuestion({ projectId }))
  const app = await appWithReplies(['prose 1', 'prose 2', 'prose 3', 'prose 4'])

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/optimize`,
    payload: { text: 'oui vas-y' },
    cookies: { hm_session: cookie },
  })

  expect(res.statusCode).toBe(502)
  expect(res.json()).toEqual({ error: 'optimisation_echouee' })
  await app.close()
})

test('aucune écriture en base : le statut et human_response de l item restent intacts après optimize', async () => {
  const { projectId } = await createProject()
  const item = await createInboxItem(db, makeQuestion({ projectId }))
  const app = await appWithReplies([
    { toolUse: { name: 'submit_optimized_answer', input: validPayload } },
  ])

  await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/optimize`,
    payload: { text: 'oui vas-y' },
    cookies: { hm_session: cookie },
  })

  const row = await db
    .selectFrom('inbox_items')
    .select(['status', 'human_response'])
    .where('id', '=', item.id)
    .executeTakeFirstOrThrow()
  expect(row.status).toBe('open')
  expect(row.human_response).toBeNull()
  await app.close()
})

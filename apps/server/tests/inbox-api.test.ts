import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { type CreateInboxItemInput, createInboxItem } from '../src/inbox/repo'
import { createBoss } from '../src/jobs/boss'
import { RUN_STEP_QUEUE } from '../src/jobs/run-step'
import { proposerSavoirs } from '../src/knowledge/propose'
import { rappeler } from '../src/knowledge/recall'
import { applyEvent } from '../src/loop/orchestrator'
import { ensureGlobe } from './fixtures'
import { stopBoss } from './stop-boss'

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const boss: PgBoss = createBoss(env)
const app = await buildApp({ db, boss })

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

interface FixtureProject {
  projectId: string
  slug: string
}

/** Un globe + projet + step + run neufs, prêts à porter un item d'inbox. */
async function createRun(opts: { state?: 'framing' | 'coding' | 'reviewing' } = {}) {
  const globe = await ensureGlobe(db)
  const slug = `p-inbox-api-${randomUUID()}`
  const project = await db
    .insertInto('projects')
    .values({ globe_id: globe.id, name: 'P', slug, repo_full_name: 'a/b' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'T', specs: '## S' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id, ...(opts.state ? { state: opts.state } : {}) })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { runId: run.id, projectId: project.id, slug } satisfies FixtureProject & { runId: string }
}

async function createProject(): Promise<FixtureProject> {
  const globe = await ensureGlobe(db)
  const slug = `p-inbox-plain-${randomUUID()}`
  const project = await db
    .insertInto('projects')
    .values({ globe_id: globe.id, name: 'P', slug, repo_full_name: 'a/b' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { projectId: project.id, slug }
}

function makeInput(overrides: Partial<CreateInboxItemInput> = {}): CreateInboxItemInput {
  return { type: 'alert', title: 'Alerte de test', ...overrides }
}

async function pendingRunStepJobs(runId: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from pgboss.job
    where name = ${RUN_STEP_QUEUE} and data->>'runId' = ${runId}
  `.execute(db)
  return Number(rows.rows[0]?.count ?? 0)
}

// --- Authentification ---

test('GET /api/inbox sans cookie renvoie 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/inbox' })
  expect(res.statusCode).toBe(401)
})

test('POST /api/inbox/:id/resolve sans cookie renvoie 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${randomUUID()}/resolve`,
    payload: { response: { text: 'x' } },
  })
  expect(res.statusCode).toBe(401)
})

// --- GET /api/inbox : forme, filtres ---

test('GET /api/inbox rend la forme de INBOX[] (data.js) sans age/ageMin, avec blockedSince/createdAt bruts', async () => {
  const { projectId, slug } = await createProject()
  const item = await createInboxItem(
    db,
    makeInput({ type: 'question', title: 'SIRET du client ?', projectId, fromRole: 'garant' }),
  )

  const res = await app.inject({
    method: 'GET',
    url: `/api/inbox?project=${slug}`,
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  const found = body.find((i: { id: string }) => i.id === item.id)

  expect(found).toMatchObject({
    id: item.id,
    type: 'question',
    title: 'SIRET du client ?',
    project: slug,
    agent: 'garant',
    status: 'open',
  })
  expect(found.age).toBeUndefined()
  expect(found.ageMin).toBeUndefined()
  expect(typeof found.blockedSince).toBe('string')
  expect(typeof found.createdAt).toBe('string')
  expect(new Date(found.blockedSince).toString()).not.toBe('Invalid Date')
})

test('GET /api/inbox rend payload et archiveToClient (Task 7 : contenu des panneaux)', async () => {
  const { projectId } = await createProject()
  const item = await createInboxItem(
    db,
    makeInput({
      type: 'approval',
      subtype: 'email',
      title: 'Relance client',
      projectId,
      payload: { email: { from: 'a@desura.fr', to: 'b@client.fr', subject: 'S', body: 'B' } },
      archiveToClient: false,
    }),
  )

  const res = await app.inject({
    method: 'GET',
    url: '/api/inbox',
    cookies: { hm_session: cookie },
  })
  const body = res.json() as Array<Record<string, unknown>>
  const found = body.find((i) => i.id === item.id)

  expect(found?.payload).toEqual({
    email: { from: 'a@desura.fr', to: 'b@client.fr', subject: 'S', body: 'B' },
  })
  expect(found?.archiveToClient).toBe(false)
})

test('GET /api/inbox : la clé "sub" est absente sans sous-type, présente avec', async () => {
  const { projectId } = await createProject()
  const withSub = await createInboxItem(
    db,
    makeInput({ type: 'approval', subtype: 'email', title: 'Relance client', projectId }),
  )
  const withoutSub = await createInboxItem(
    db,
    makeInput({ type: 'question', title: 'Question nue', projectId }),
  )

  const res = await app.inject({
    method: 'GET',
    url: '/api/inbox',
    cookies: { hm_session: cookie },
  })
  const body = res.json() as Array<Record<string, unknown>>

  const found1 = body.find((i) => i.id === withSub.id)
  const found2 = body.find((i) => i.id === withoutSub.id)
  expect(found1?.sub).toBe('email')
  expect('sub' in (found2 ?? {})).toBe(false)
})

test('GET /api/inbox?status=open filtre par statut', async () => {
  const { projectId } = await createProject()
  const item = await createInboxItem(db, makeInput({ projectId, title: 'Statut test' }))

  const res = await app.inject({
    method: 'GET',
    url: '/api/inbox?status=open',
    cookies: { hm_session: cookie },
  })
  const body = res.json() as Array<{ id: string; status: string }>
  expect(body.every((i) => i.status === 'open')).toBe(true)
  expect(body.map((i) => i.id)).toContain(item.id)
})

test('GET /api/inbox?type=alert filtre par type', async () => {
  const { projectId } = await createProject()
  const alert = await createInboxItem(
    db,
    makeInput({ type: 'alert', projectId, title: 'Alerte filtrée' }),
  )
  const question = await createInboxItem(
    db,
    makeInput({ type: 'question', projectId, title: 'Question filtrée' }),
  )

  const res = await app.inject({
    method: 'GET',
    url: '/api/inbox?type=alert',
    cookies: { hm_session: cookie },
  })
  const body = res.json() as Array<{ id: string; type: string }>
  expect(body.every((i) => i.type === 'alert')).toBe(true)
  expect(body.map((i) => i.id)).toContain(alert.id)
  expect(body.map((i) => i.id)).not.toContain(question.id)
})

test('GET /api/inbox?project=<slug inconnu> renvoie une liste vide, pas une erreur', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/inbox?project=slug-totalement-inconnu',
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual([])
})

test('GET /api/inbox?status=bogus renvoie 400', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/inbox?status=bogus',
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(400)
})

test('GET /api/inbox?type=bogus renvoie 400', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/inbox?type=bogus',
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(400)
})

// --- POST /api/inbox/:id/resolve ---

test('POST /api/inbox/:id/resolve avec un id non-uuid renvoie 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/inbox/pas-un-uuid/resolve',
    payload: { response: { text: 'x' } },
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(400)
})

test('POST /api/inbox/:id/resolve avec response.text non-string renvoie 400', async () => {
  const { projectId } = await createProject()
  const item = await createInboxItem(db, makeInput({ projectId, title: 'Body invalide' }))

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/resolve`,
    payload: { response: { text: 42 } },
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(400)
})

test('POST /api/inbox/:id/resolve sans corps "response" renvoie 400', async () => {
  const { projectId } = await createProject()
  const item = await createInboxItem(db, makeInput({ projectId, title: 'Sans response' }))

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/resolve`,
    payload: {},
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(400)
})

test('POST /api/inbox/:id/resolve sur un id inconnu renvoie 404', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${randomUUID()}/resolve`,
    payload: { response: { text: 'x' } },
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(404)
})

test('POST /api/inbox/:id/resolve resout l item et rend sa forme (project = slug)', async () => {
  const { projectId, slug } = await createProject()
  const item = await createInboxItem(
    db,
    makeInput({ projectId, title: 'À résoudre', fromRole: 'dev' }),
  )

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/resolve`,
    payload: { response: { text: 'traité' } },
    cookies: { hm_session: cookie },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.item).toMatchObject({ id: item.id, status: 'done', project: slug, agent: 'dev' })
  expect(body.runResumed).toBe(false)
})

test('POST /api/inbox/:id/resolve resolu deux fois renvoie 409 la seconde fois', async () => {
  const { projectId } = await createProject()
  const item = await createInboxItem(db, makeInput({ projectId, title: 'Deux fois' }))

  const first = await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/resolve`,
    payload: { response: { text: 'A' } },
    cookies: { hm_session: cookie },
  })
  expect(first.statusCode).toBe(200)

  const second = await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/resolve`,
    payload: { response: { text: 'B' } },
    cookies: { hm_session: cookie },
  })
  expect(second.statusCode).toBe(409)
})

test('POST /api/inbox/:id/resolve sur un item bloquant relance réellement le run (job ré-enfilé)', async () => {
  const { runId } = await createRun({ state: 'coding' })

  await applyEvent(db, runId, { type: 'question', blocking: true, fromRole: 'garant' })

  const item = await db
    .selectFrom('inbox_items')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()

  const jobsBefore = await pendingRunStepJobs(runId)

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${item.id}/resolve`,
    payload: { response: { text: 'voici la réponse' } },
    cookies: { hm_session: cookie },
  })

  expect(res.statusCode).toBe(200)
  expect(res.json().runResumed).toBe(true)

  const run = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(run.state).toBe('coding')
  expect(await pendingRunStepJobs(runId)).toBeGreaterThan(jobsBefore)
})

// --- Chaîne HTTP → archivage d'un savoir (Phase 7, Task 3) ---

test('POST /api/inbox/:id/resolve sur un savoir approuvé archive la formulation corrigée', async () => {
  const { runId, projectId } = await createRun()
  const { proposes } = await proposerSavoirs(db, {
    runId,
    projectId,
    candidats: [
      {
        sujet: 'limite upload',
        contenu: 'Ce serveur refuse tout upload au-delà de 2 Mo, sans message d’erreur.',
        cercle: 'projet',
      },
    ],
  })
  const itemId = proposes[0]?.id as string

  const corrige =
    'Uploads plafonnés à 2 Mo côté serveur · aucun message d’erreur, échec silencieux.'
  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${itemId}/resolve`,
    payload: { response: { approved: true, text: corrige } },
    cookies: { hm_session: cookie },
  })

  expect(res.statusCode).toBe(200)
  expect(res.json().savoirArchived).toBe(true)
  // Le run n'a pas été réveillé : une proposition de savoir ne bloque rien.
  expect(res.json().runResumed).toBe(false)

  // C'est la formulation de Florian qui est rappelée, jamais celle du garant.
  const rappeles = await rappeler(db, { projetId: projectId })
  expect(rappeles.map((s) => s.contenu)).toEqual([corrige])
})

test('POST /api/inbox/:id/resolve sur un savoir refusé n archive rien', async () => {
  const { runId, projectId } = await createRun()
  const { proposes } = await proposerSavoirs(db, {
    runId,
    projectId,
    candidats: [
      {
        sujet: 'cache CDN',
        contenu: 'Le CDN de ce client garde les assets 24 h, purger après chaque déploiement.',
        cercle: 'projet',
      },
    ],
  })

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${proposes[0]?.id}/resolve`,
    payload: { response: { approved: false } },
    cookies: { hm_session: cookie },
  })

  expect(res.statusCode).toBe(200)
  expect(res.json().savoirArchived).toBe(false)
  expect(await rappeler(db, { projetId: projectId })).toHaveLength(0)
})

import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { appendMessage, readRunMessages } from '../src/loop/bus'
import { ensureGlobe } from './fixtures'

const db = createDb(createPool(databaseUrl(loadEnv())))
let runId: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)

  const globe = await ensureGlobe(db)
  const project = await db
    .insertInto('projects')
    .values({ globe_id: globe.id, name: 'P', slug: 'p-bus', repo_full_name: 'a/b' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'T', specs: '## S' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id })
    .returning('id')
    .executeTakeFirstOrThrow()
  runId = run.id
})
afterAll(async () => {
  await db.destroy()
})

test('l ordre chronologique est preserve, meme a la milliseconde', async () => {
  for (let i = 0; i < 10; i++) {
    await appendMessage(db, {
      runId,
      fromRole: 'garant',
      toRole: 'dev',
      kind: 'prompt',
      body: `message ${i}`,
    })
  }

  const messages = await readRunMessages(db, runId)
  expect(messages.map((m) => m.body)).toEqual(Array.from({ length: 10 }, (_, i) => `message ${i}`))
})

test('meta fait l aller-retour JSON', async () => {
  await appendMessage(db, {
    runId,
    fromRole: 'dev',
    toRole: 'garant',
    kind: 'report',
    body: 'rapport',
    meta: { prNumber: 42, doubts: ['cache', 'i18n'] },
  })

  const last = (await readRunMessages(db, runId)).at(-1)
  expect(last?.meta).toEqual({ prNumber: 42, doubts: ['cache', 'i18n'] })
})

test('meta absente devient un objet vide, jamais null', async () => {
  await appendMessage(db, {
    runId,
    fromRole: 'system',
    toRole: 'garant',
    kind: 'info',
    body: 'sans meta',
  })
  expect((await readRunMessages(db, runId)).at(-1)?.meta).toEqual({})
})

test('un run inexistant est refuse par la cle etrangere', async () => {
  await expect(
    appendMessage(db, {
      runId: '00000000-0000-0000-0000-000000000000',
      fromRole: 'garant',
      toRole: 'dev',
      kind: 'prompt',
      body: 'orphelin',
    }),
  ).rejects.toThrow()
})

test('la timeline d un autre run est vide', async () => {
  const step = await db.selectFrom('steps').select('id').executeTakeFirstOrThrow()
  const other = await db
    .insertInto('runs')
    .values({ step_id: step.id })
    .returning('id')
    .executeTakeFirstOrThrow()

  expect(await readRunMessages(db, other.id)).toEqual([])
})

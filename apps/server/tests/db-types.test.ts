import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { loadEnv } from '../src/env'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts) ;
// sans cet appel, DATABASE_URL_TEST serait undefined à ce stade.
loadEnv()

const pool = createPool(process.env.DATABASE_URL_TEST as string)
const db = createDb(pool)

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
afterAll(async () => {
  await db.destroy()
})

test('insère un client, un projet et un step reliés', async () => {
  const client = await db
    .insertInto('clients')
    .values({ name: 'Acme', tone: 'direct' })
    .returningAll()
    .executeTakeFirstOrThrow()

  const project = await db
    .insertInto('projects')
    .values({
      client_id: client.id,
      name: 'Site Acme',
      slug: 'acme-site',
      repo_full_name: 'desura/acme',
      context: '# Contexte\nUn site vitrine.',
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  expect(project.autonomy_default).toBe('gated')
  expect(project.budget_weight).toBe(5)

  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'Header', specs: '## Specs' })
    .returningAll()
    .executeTakeFirstOrThrow()

  expect(step.status).toBe('pending')
  expect(step.max_iterations).toBe(4)
})

test('refuse un budget_weight hors bornes', async () => {
  await expect(
    db
      .insertInto('projects')
      .values({ name: 'X', slug: 'x', repo_full_name: 'a/b', budget_weight: 99 })
      .execute(),
  ).rejects.toThrow()
})

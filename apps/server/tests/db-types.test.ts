import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { ensureGlobe } from './fixtures'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts).
// Passer par databaseUrl() plutôt qu'une URL en dur : sinon un changement de
// configuration ferait tourner les tests contre une autre base sans le dire.
const pool = createPool(databaseUrl(loadEnv()))
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

  const globe = await ensureGlobe(db)

  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
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
  const globe = await ensureGlobe(db)
  await expect(
    db
      .insertInto('projects')
      .values({
        globe_id: globe.id,
        name: 'X',
        slug: 'x',
        repo_full_name: 'a/b',
        budget_weight: 99,
      })
      .execute(),
  ).rejects.toThrow()
})

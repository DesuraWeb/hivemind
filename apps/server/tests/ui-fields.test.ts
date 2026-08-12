import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'

const db = createDb(createPool(databaseUrl(loadEnv())))
let projectId: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  const globe = await db.selectFrom('globes').select('id').executeTakeFirstOrThrow()
  const p = await db
    .insertInto('projects')
    .values({ globe_id: globe.id, name: 'Le Koin', slug: 'koin', repo_full_name: 'a/b' })
    .returning('id')
    .executeTakeFirstOrThrow()
  projectId = p.id
})
afterAll(async () => {
  await db.destroy()
})

test('tint et synth sont nullables et se relisent', async () => {
  const before = await db
    .selectFrom('projects')
    .select(['tint', 'synth'])
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow()
  expect(before.tint).toBeNull()
  expect(before.synth).toBeNull()

  await db
    .updateTable('projects')
    .set({ tint: '#7FD9CF', synth: 'Le dev itère sereinement · prod du step 3 à valider.' })
    .where('id', '=', projectId)
    .execute()

  const after = await db
    .selectFrom('projects')
    .select(['tint', 'synth'])
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow()
  expect(after.tint).toBe('#7FD9CF')
  // La règle DA interdit le tiret cadratin dans l'UI : le backend la respecte
  // aussi, puisque cette chaîne est rendue telle quelle.
  expect(after.synth).not.toContain('—')
})

test('from_role distingue deux questions du meme projet', async () => {
  const garant = await db
    .insertInto('inbox_items')
    .values({
      type: 'question',
      title: 'SIRET du client Bastide ?',
      project_id: projectId,
      from_role: 'garant',
      payload: '{}',
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  const dev = await db
    .insertInto('inbox_items')
    .values({
      type: 'question',
      title: 'Accès FTP legacy ?',
      project_id: projectId,
      from_role: 'dev',
      payload: '{}',
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  expect(garant.from_role).toBe('garant')
  expect(dev.from_role).toBe('dev')
})

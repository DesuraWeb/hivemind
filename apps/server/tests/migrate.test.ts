import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://localhost:5432/hivemind_test'
const pool = createPool(url)
const db = createDb(pool)

beforeAll(async () => {
  // Repart d'un schéma vierge à chaque exécution de la suite.
  await sql`drop schema public cascade; create schema public;`.execute(db)
})

afterAll(async () => {
  await db.destroy()
})

test('applique les migrations et enregistre leur nom', async () => {
  const applied = await runMigrations(db)
  expect(applied).toContain('0001_init.sql')

  const rows = await sql<{ name: string }>`select name from schema_migrations`.execute(db)
  expect(rows.rows.map((r) => r.name)).toContain('0001_init.sql')
})

test('est idempotent : un second passage n applique rien', async () => {
  const applied = await runMigrations(db)
  expect(applied).toEqual([])
})

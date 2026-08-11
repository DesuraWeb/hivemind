import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts).
// Passer par databaseUrl() plutôt qu'une URL en dur : sinon un changement de
// configuration ferait tourner les tests contre une autre base sans le dire.
const pool = createPool(databaseUrl(loadEnv()))
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

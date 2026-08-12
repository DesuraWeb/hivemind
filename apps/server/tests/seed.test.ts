import { ROLE_KEYS } from '@chapo/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'

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

test('insère les 6 templates generic v1 avec un prompt non vide', async () => {
  await seedRoleTemplates(db)
  const rows = await db.selectFrom('role_templates').selectAll().execute()

  expect(rows).toHaveLength(ROLE_KEYS.length)
  for (const key of ROLE_KEYS) {
    const row = rows.find((r) => r.key === key)
    expect(row, `template manquant : ${key}`).toBeDefined()
    expect(row?.project_type).toBe('generic')
    expect(row?.version).toBe(1)
    expect((row?.system_prompt ?? '').length).toBeGreaterThan(200)
  }
})

test('est idempotent : un second seed ne duplique pas', async () => {
  await seedRoleTemplates(db)
  const rows = await db.selectFrom('role_templates').selectAll().execute()
  expect(rows).toHaveLength(ROLE_KEYS.length)
})

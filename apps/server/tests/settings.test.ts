import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createSecretBox, generateMasterKey } from '../src/crypto/secrets'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { createSettingsStore } from '../src/settings/store'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts).
// Passer par databaseUrl() plutôt qu'une URL en dur : sinon un changement de
// configuration ferait tourner les tests contre une autre base sans le dire.
const pool = createPool(databaseUrl(loadEnv()))
const db = createDb(pool)
const app = await buildApp({ db })

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
})

async function store() {
  return createSettingsStore(db, await createSecretBox(generateMasterKey()))
}

test('un réglage en clair fait l aller-retour', async () => {
  const s = await store()
  await s.set('budget.day_threshold_pct', 70)
  expect(await s.get('budget.day_threshold_pct')).toBe(70)
})

test('set écrase la valeur précédente', async () => {
  const s = await store()
  await s.set('budget.day_threshold_pct', 70)
  await s.set('budget.day_threshold_pct', 85)
  expect(await s.get('budget.day_threshold_pct')).toBe(85)
})

test('une clé absente renvoie undefined', async () => {
  const s = await store()
  expect(await s.get('inexistant')).toBeUndefined()
})

test('un secret est chiffré en base et relisible par le store', async () => {
  const s = await store()
  await s.setSecret('smtp.pass', 'hunter2')

  const raw = await db
    .selectFrom('settings')
    .select('value')
    .where('key', '=', 'smtp.pass')
    .executeTakeFirstOrThrow()

  expect(JSON.stringify(raw.value)).not.toContain('hunter2')
  expect(await s.getSecret('smtp.pass')).toBe('hunter2')
})

test('listPublic masque les secrets et expose les clairs', async () => {
  const s = await store()
  await s.set('budget.day_threshold_pct', 70)
  await s.setSecret('smtp.pass', 'hunter2')

  const listed = await s.listPublic()
  expect(listed['budget.day_threshold_pct']).toBe(70)
  expect(listed['smtp.pass']).toBe('***')
  expect(JSON.stringify(listed)).not.toContain('hunter2')
})

test('GET /api/settings sans cookie renvoie 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/settings' })
  expect(res.statusCode).toBe(401)
})

test('PUT /api/settings sans cookie renvoie 401', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { key: 'budget.day_threshold_pct', value: 42 },
  })
  expect(res.statusCode).toBe(401)
})

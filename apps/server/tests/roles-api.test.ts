import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createSecretBox } from '../src/crypto/secrets'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { createSettingsStore } from '../src/settings/store'
import { ensureGlobe } from './fixtures'

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const app = await buildApp({ db })

let cookie: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await createUser(db, 'florian', 'motdepasse-de-test')
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
  await db.destroy()
})

function get(url: string) {
  return app.inject({ method: 'GET', url, cookies: { hm_session: cookie } })
}

test('les deux routes exigent une session', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/role-templates' })).statusCode).toBe(401)
  expect((await app.inject({ method: 'GET', url: '/api/vault' })).statusCode).toBe(401)
})

test('les templates sortent par version décroissante, avec leur nombre de projets', async () => {
  const v1 = await db
    .insertInto('role_templates')
    .values({
      key: 'dev',
      project_type: 'generic',
      version: 1,
      system_prompt: '# v1',
      tools: JSON.stringify({ bash: true, fs: 'write', mcp: [] }),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await db
    .insertInto('role_templates')
    .values({
      key: 'dev',
      project_type: 'generic',
      version: 2,
      system_prompt: '# v2',
      tools: JSON.stringify({ bash: true, fs: 'write', mcp: [] }),
      model: 'claude-opus-5',
    })
    .execute()

  // Deux projets matérialisent la v1 : c'est ce que doit compter `usedByProjects`.
  const globe = await ensureGlobe(db)
  for (let i = 0; i < 2; i++) {
    const project = await db
      .insertInto('projects')
      .values({
        globe_id: globe.id,
        name: `Projet ${i}`,
        slug: `projet-role-${randomUUID()}`,
        repo_full_name: 'desura/x',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('roles')
      .values({
        project_id: project.id,
        template_id: v1.id,
        key: 'dev',
        system_prompt: '# v1',
        tools: JSON.stringify({ bash: true, fs: 'write', mcp: [] }),
      })
      .execute()
  }

  const body = (await get('/api/role-templates')).json()
  const dev = body.filter((t: { key: string }) => t.key === 'dev')
  // La version la plus haute d'abord : c'est celle qui s'applique.
  expect(dev.map((t: { version: number }) => t.version)).toEqual([2, 1])
  expect(dev[0].model).toBe('claude-opus-5')
  expect(dev[0].usedByProjects).toBe(0)
  expect(dev[1].usedByProjects).toBe(2)
  // Aucune colonne d'horodatage sur la table : `null`, jamais une date inventée.
  expect(dev[0].modifiedAt).toBeNull()
})

test("le coffre s'inventorie sans jamais rendre une valeur", async () => {
  const settings = createSettingsStore(db, await createSecretBox(env.MASTER_KEY))
  await settings.setSecret('gmail.oauth.refresh_token', 'VALEUR-QUI-NE-DOIT-JAMAIS-SORTIR')
  await settings.set('budget.reserve_pct', 15)

  const res = await get('/api/vault')
  const body = res.json()

  expect(body).toEqual([{ key: 'gmail.oauth.refresh_token' }])
  // Un réglage ordinaire n'est pas un secret : il n'a rien à faire dans
  // l'inventaire du coffre.
  expect(body.map((e: { key: string }) => e.key)).not.toContain('budget.reserve_pct')
  // Cherché dans le corps sérialisé entier, pas dans le champ où on
  // l'attendrait : une fuite par un champ oublié doit faire échouer ce test.
  expect(res.body).not.toContain('VALEUR-QUI-NE-DOIT-JAMAIS-SORTIR')
  // Et pas non plus le masque : on ne renvoie que des clés, pas un
  // dictionnaire dont les valeurs auraient été remplacées.
  expect(res.body).not.toContain('***')
})

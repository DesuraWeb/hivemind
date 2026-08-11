import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts).
// Passer par databaseUrl() plutôt qu'une URL en dur : sinon un changement de
// configuration ferait tourner les tests contre une autre base sans le dire.
const pool = createPool(databaseUrl(loadEnv()))
const db = createDb(pool)
const app = await buildApp({ db })

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await createUser(db, 'florian', 'motdepasse-de-test')
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

test('GET /api/health répond sans authentification', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toMatchObject({ status: 'ok' })
})

test('GET /api/me sans cookie renvoie 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/me' })
  expect(res.statusCode).toBe(401)
})

test('login avec un mauvais mot de passe renvoie 401 et aucun cookie', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'faux' },
  })
  expect(res.statusCode).toBe(401)
  expect(res.cookies).toHaveLength(0)
})

test('login avec un utilisateur inconnu renvoie 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'inconnu', password: 'motdepasse-de-test' },
  })
  expect(res.statusCode).toBe(401)
})

test('login valide puis /api/me avec le cookie', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  expect(login.statusCode).toBe(200)

  const cookie = login.cookies.find((c) => c.name === 'hm_session')
  expect(cookie).toBeDefined()
  expect(cookie?.httpOnly).toBe(true)
  expect(cookie?.sameSite?.toLowerCase()).toBe('lax')

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: { hm_session: cookie?.value as string },
  })
  expect(me.statusCode).toBe(200)
  expect(me.json()).toMatchObject({ login: 'florian' })
})

test('un cookie falsifié est rejeté', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: { hm_session: 'valeur-inventee' },
  })
  expect(res.statusCode).toBe(401)
})

test('logout invalide la session', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  const value = login.cookies.find((c) => c.name === 'hm_session')?.value as string

  const out = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    cookies: { hm_session: value },
  })
  expect(out.statusCode).toBe(200)
  expect(out.cookies.find((c) => c.name === 'hm_session')?.value).toBe('')
})

test('le hash du mot de passe n est jamais renvoyé par l API', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  expect(login.body).not.toContain('$argon2')
})

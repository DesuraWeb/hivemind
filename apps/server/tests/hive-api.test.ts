import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { createFakeAdapter } from '../src/runtime/fake'
import type { RuntimeAdapter } from '../src/runtime/types'

/** Aucun token : l'adapter factice repond du texte scripte. */
const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const adapter = createFakeAdapter({
  replies: ['Le Koin en est au step 4 sur 7, le dev itere.', 'Deuxieme reponse.'],
})
const app = await buildApp({ db, adapter })

let cookie: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await seedRoleTemplates(db)
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
function post(url: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url, payload, cookies: { hm_session: cookie } })
}

test('les deux routes exigent une session', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/hive/messages' })).statusCode).toBe(401)
  expect((await app.inject({ method: 'POST', url: '/api/hive/messages' })).statusCode).toBe(401)
})

test('un echange aller-retour est persiste dans l ordre', async () => {
  const res = await post('/api/hive/messages', { text: 'Ou en est le Koin ?' })
  expect(res.statusCode).toBe(200)
  expect(res.json().reply.body).toContain('step 4')
  expect(res.json().reply.from).toBe('majordome')

  const fil = (await get('/api/hive/messages')).json()
  // Du plus ancien au plus recent : un fil se lit dans le sens de la lecture.
  expect(fil).toHaveLength(2)
  expect(fil[0].from).toBe('florian')
  expect(fil[0].body).toBe('Ou en est le Koin ?')
  expect(fil[1].from).toBe('majordome')
})

test('la conversation Hive ne pollue ni la timeline d un run ni le journal', async () => {
  await post('/api/hive/messages', { text: 'Encore une question.' })

  // Les messages Hive ont run_id null : ils ne peuvent pas apparaitre dans un
  // run, et le journal fait une jointure interne sur runs.
  const orphelins = await db
    .selectFrom('messages')
    .select('id')
    .where('run_id', 'is', null)
    .execute()
  expect(orphelins.length).toBeGreaterThan(0)

  const journal = (await get('/api/journal')).json()
  expect(journal.night).toEqual([])
})

test('un message vide ou demesure est refuse', async () => {
  expect((await post('/api/hive/messages', { text: '' })).statusCode).toBe(400)
  expect((await post('/api/hive/messages', { text: 'x'.repeat(4001) })).statusCode).toBe(400)
})

test('si Hive echoue, la question de Florian n est PAS perdue', async () => {
  // Un adapter dont `send` leve : c'est le cas qu'on veut couvrir, pas un
  // adapter a court de reponses scriptees (qui, lui, rend une chaine vide).
  const base = createFakeAdapter({ replies: [] })
  const casse: RuntimeAdapter = {
    ...base,
    send: async () => {
      throw new Error('runtime injoignable')
    },
  }
  const appCasse = await buildApp({ db, adapter: casse })
  await appCasse.ready()
  const login = await appCasse.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  const c = login.cookies.find((x) => x.name === 'hm_session')?.value as string

  const question = `Question qui ne doit pas disparaitre ${randomUUID().slice(0, 8)}`
  const res = await appCasse.inject({
    method: 'POST',
    url: '/api/hive/messages',
    payload: { text: question },
    cookies: { hm_session: c },
  })
  expect(res.statusCode).toBe(502)

  // Ecrite AVANT l'appel au modele : c'est tout l'interet de cet ordre.
  const fil = (await get('/api/hive/messages')).json()
  expect(fil.map((m: { body: string }) => m.body)).toContain(question)

  await appCasse.close()
})

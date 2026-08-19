import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
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

async function createClientFixture(): Promise<string> {
  const row = await db
    .insertInto('clients')
    .values({
      name: 'Atelier Bastide',
      siret: '812 394 176 00027',
      tone: 'Direct et chaleureux · vouvoiement · jamais de jargon technique.',
      contacts: JSON.stringify([
        { name: 'Marie', role: 'Gérante', email: 'marie@bastide.fr', phone: '04 42 00 00 00' },
        // Entrée volontairement incomplète : une fiche mal remplie ne doit pas
        // faire tomber la page.
        { name: 'Alternante' },
      ]),
      notes: JSON.stringify([
        {
          q: 'Qui valide les contenus produits ?',
          a: 'Marie directement · jamais son alternante.',
          source_item_id: 'q-98',
          at: '2026-08-03T10:00:00Z',
        },
        // Note sans réponse : ce n'est pas un savoir, elle ne doit pas
        // apparaître comme une ligne vide.
        { q: 'Question restée sans réponse ?' },
      ]),
      secrets: JSON.stringify({
        ssh_password: 'SUPER-SECRET-NE-DOIT-JAMAIS-SORTIR',
        ftp_password: 'AUTRE-SECRET',
      }),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

test('GET /api/clients sans cookie renvoie 401', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/clients' })).statusCode).toBe(401)
})

test('la fiche porte le ton, les contacts et les savoirs issus de l inbox', async () => {
  const id = await createClientFixture()

  const res = await get(`/api/clients/${id}`)
  expect(res.statusCode).toBe(200)
  const body = res.json()

  expect(body.name).toBe('Atelier Bastide')
  expect(body.siret).toBe('812 394 176 00027')
  // Le ton fait foi pour le communicant : sans lui, il improvise.
  expect(body.tone).toContain('Direct et chaleureux')

  expect(body.contacts).toHaveLength(2)
  expect(body.contacts[0].email).toBe('marie@bastide.fr')
  // Champs absents rendus `null`, pas `undefined` ni une ligne manquante.
  expect(body.contacts[1]).toEqual({
    name: 'Alternante',
    role: null,
    email: null,
    phone: null,
  })

  // Une seule des deux notes est un savoir : l'autre n'a pas de réponse.
  expect(body.knowledge).toHaveLength(1)
  expect(body.knowledge[0].question).toBe('Qui valide les contenus produits ?')
  expect(body.knowledge[0].sourceItemId).toBe('q-98')
})

test('AUCUNE valeur de secret ne sort de l API, seulement les noms des accès', async () => {
  const id = await createClientFixture()

  const res = await get(`/api/clients/${id}`)
  const body = res.json()

  expect(body.accessKeys).toEqual(['ftp_password', 'ssh_password'])
  // Le test qui compte : on cherche la valeur dans TOUT le corps sérialisé,
  // pas seulement dans le champ où on l'attendrait. Un secret qui fuirait par
  // un champ oublié doit faire échouer ce test.
  expect(res.body).not.toContain('SUPER-SECRET-NE-DOIT-JAMAIS-SORTIR')
  expect(res.body).not.toContain('AUTRE-SECRET')

  const liste = await get('/api/clients')
  expect(liste.body).not.toContain('SUPER-SECRET-NE-DOIT-JAMAIS-SORTIR')
})

test('les projets rattachés sont listés par slug', async () => {
  const clientId = await createClientFixture()
  const globe = await ensureGlobe(db)
  const slug = `projet-client-${randomUUID()}`
  await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      client_id: clientId,
      name: 'Boutique Bastide',
      slug,
      repo_full_name: 'desura/bastide',
    })
    .execute()

  const body = (await get(`/api/clients/${clientId}`)).json()
  expect(body.projects).toEqual([{ id: slug, name: 'Boutique Bastide' }])
})

test('un client inconnu renvoie 404, pas une fiche vide', async () => {
  const res = await get(`/api/clients/${randomUUID()}`)
  expect(res.statusCode).toBe(404)
})

test('une fiche vierge ne casse rien et ne rend aucun champ indéfini', async () => {
  const row = await db
    .insertInto('clients')
    .values({ name: 'Client sans rien' })
    .returning('id')
    .executeTakeFirstOrThrow()

  const body = (await get(`/api/clients/${row.id}`)).json()
  expect(body.siret).toBeNull()
  expect(body.tone).toBeNull()
  expect(body.contacts).toEqual([])
  expect(body.knowledge).toEqual([])
  expect(body.accessKeys).toEqual([])
  expect(body.projects).toEqual([])
})

import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { createInboxItem } from '../src/inbox/repo'
import { createFakeAdapter } from '../src/runtime/fake'
import type { RuntimeAdapter, UsageSnapshot } from '../src/runtime/types'

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))

/** Jauge saine : rien a signaler cote budget. */
const SAINE: UsageSnapshot = {
  fiveHourPct: 12,
  sevenDayPct: 20,
  available: true,
  sampledAt: new Date(),
}
/** Jauge au-dessus du seuil de pause (85 %). */
const EPUISEE: UsageSnapshot = {
  fiveHourPct: 97,
  sevenDayPct: 30,
  available: true,
  sampledAt: new Date(),
}

let usage: UsageSnapshot = SAINE
const base = createFakeAdapter()
const adapter: RuntimeAdapter = { ...base, usage: async () => usage }
const app = await buildApp({ db, adapter })

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

function status() {
  return app.inject({ method: 'GET', url: '/api/system/status', cookies: { hm_session: cookie } })
}

test('la route exige une session', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/system/status' })).statusCode).toBe(401)
})

test('nominal : le systeme ne dit RIEN', async () => {
  usage = SAINE
  const body = (await status()).json()
  // « Le systeme ne parle que quand quelque chose se degrade » : une liste
  // vide est le resultat attendu, pas un echec.
  expect(body.degradations).toEqual([])
})

test('fenetre epuisee : un bandeau, avec ce qui arrive aux boucles', async () => {
  usage = EPUISEE
  const body = (await status()).json()
  const budget = body.degradations.find((d: { kind: string }) => d.kind === 'budget')
  expect(budget).toBeDefined()
  expect(budget.text).toContain('97 %')
  expect(budget.text).toContain('intacte')
  expect(budget.loops).toContain('pause budgetaire'.replace('budgetaire', 'budgétaire'))
  // Puiser dans la reserve est une decision explicite : le bandeau propose.
  expect(budget.action.label).toContain('réserve')
  usage = SAINE
})

test("une alerte d'auth deja levee est LUE, pas refaite", async () => {
  // Le cron leve l'item ; la route ne rouvre pas de session d'agent pour le
  // verifier — ce serait payer un token a chaque affichage de page.
  await createInboxItem(db, {
    type: 'alert',
    title: 'Runtime injoignable',
    payload: { cause: 'auth.runtime_indisponible' },
  })

  const body = (await status()).json()
  const auth = body.degradations.find((d: { kind: string }) => d.kind === 'auth')
  expect(auth).toBeDefined()
  expect(auth.loops).toContain('endormies')
})

test('une alerte de securite se voit sans bloquer les boucles', async () => {
  await createInboxItem(db, {
    type: 'alert',
    subtype: 'security_selfmod',
    title: 'PR #12 modifie la frontiere de securite',
    payload: {},
  })

  const body = (await status()).json()
  const secu = body.degradations.find((d: { kind: string }) => d.kind === 'security')
  expect(secu).toBeDefined()
  // Le 4e gate ne bloque rien : il rend visible. Le bandeau doit le dire.
  expect(secu.loops).toContain('continuent')
})

test("Gmail n'apparait JAMAIS : rien ne mesure son etat", async () => {
  const body = (await status()).json()
  // Deduire « connecte » de la presence d'un secret affirmerait un etat
  // jamais verifie — meme raison qui a fait retirer le bloc Connexions des
  // Reglages.
  expect(JSON.stringify(body)).not.toContain('Gmail')
  expect(JSON.stringify(body)).not.toContain('gmail')
})

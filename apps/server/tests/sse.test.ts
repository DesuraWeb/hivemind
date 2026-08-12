import type { AddressInfo } from 'node:net'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { heartbeatCount } from '../src/api/events'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { eventBus } from '../src/events/bus'

// `app.inject` (le patron de auth.test.ts) ne convient pas à cette route :
// il simule une requête/réponse en mémoire sans jamais matérialiser une vraie
// connexion socket, donc rien ne se rapproche d'un `req.raw`/`reply.raw` qui
// reste ouvert indéfiniment, et surtout aucun événement `close` réaliste à
// observer pour prouver le nettoyage. On écoute donc sur un port éphémère
// (`listen({ port: 0 })`) et on pilote de vraies requêtes avec `fetch` +
// `AbortController`, qui donne accès au flux via `response.body` (un
// `ReadableStream` Web standard supporté nativement par Node 22).
const pool = createPool(databaseUrl(loadEnv()))
const db = createDb(pool)
const app = await buildApp({ db })

let base: string
let cookieHeader: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await createUser(db, 'florian', 'motdepasse-de-test')
  await app.listen({ port: 0, host: '127.0.0.1' })

  const address = app.server.address() as AddressInfo
  base = `http://127.0.0.1:${address.port}`

  // Cookie obtenu via un vrai aller-retour HTTP (pas `app.inject`) : la
  // valeur signée doit être réutilisable telle quelle dans un header `Cookie`
  // envoyé par `fetch`, ce que seul un round-trip HTTP→HTTP garantit sans
  // supputer sur l'encodage appliqué par `@fastify/cookie`.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'florian', password: 'motdepasse-de-test' }),
  })
  const setCookie = login.headers.getSetCookie()[0]
  if (!setCookie) throw new Error('login : aucun cookie de session reçu')
  cookieHeader = setCookie.split(';')[0] as string
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor : délai dépassé')
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Lit la première ligne `data: ...` du flux et la parse en JSON. */
async function readFirstDataChunk(body: ReadableStream<Uint8Array>): Promise<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) throw new Error('flux terminé avant de recevoir un événement')
      buffer += decoder.decode(value, { stream: true })
      const match = buffer.match(/^data: (.+)$/m)
      if (match?.[1]) return JSON.parse(match[1])
    }
  } finally {
    reader.releaseLock()
  }
}

test('GET /api/events sans cookie renvoie 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/events' })
  expect(res.statusCode).toBe(401)
})

test('un événement publié après connexion arrive au client au format SSE', async () => {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/events`, {
    headers: { cookie: cookieHeader },
    signal: controller.signal,
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  expect(res.headers.get('cache-control')).toContain('no-cache')

  await waitFor(() => eventBus.subscriberCount() > 0)

  const chunkPromise = readFirstDataChunk(res.body as ReadableStream<Uint8Array>)
  eventBus.publish({ type: 'inbox.new', id: 'item-1', projectId: 'proj-1' })

  const payload = await chunkPromise
  expect(payload).toEqual({ type: 'inbox.new', id: 'item-1', projectId: 'proj-1' })

  controller.abort()
})

test("fuite d'abonnés : 50 connexions ouvertes puis fermées retombent à zéro", async () => {
  await waitFor(() => eventBus.subscriberCount() === 0)
  const before = eventBus.subscriberCount()
  expect(before).toBe(0)

  const controllers = Array.from({ length: 50 }, () => new AbortController())
  const responses = await Promise.all(
    controllers.map((controller) =>
      fetch(`${base}/api/events`, { headers: { cookie: cookieHeader }, signal: controller.signal }),
    ),
  )
  for (const res of responses) expect(res.status).toBe(200)

  await waitFor(() => eventBus.subscriberCount() === 50)
  expect(eventBus.subscriberCount()).toBe(50)

  for (const controller of controllers) controller.abort()

  await waitFor(() => eventBus.subscriberCount() === 0)
  expect(eventBus.subscriberCount()).toBe(0)
})

test("le heartbeat n'empêche pas la fermeture propre : pas de timer orphelin", async () => {
  const before = heartbeatCount()

  const controller = new AbortController()
  await fetch(`${base}/api/events`, {
    headers: { cookie: cookieHeader },
    signal: controller.signal,
  })

  await waitFor(() => heartbeatCount() === before + 1)
  expect(heartbeatCount()).toBe(before + 1)

  controller.abort()

  await waitFor(() => heartbeatCount() === before)
  expect(heartbeatCount()).toBe(before)
})

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createSecretBox } from '../src/crypto/secrets'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { cleCoffre } from '../src/ops/credentials'
import type { OpsExecutor, SondeHttp } from '../src/ops/types'
import { createSettingsStore } from '../src/settings/store'

/**
 * Les routes d'exploitation (Phase 6).
 *
 * Le test qui compte : AUCUNE route ne permet de déclarer un état. Toute la
 * phase repose sur « vierge se mesure » — un formulaire qui permettrait de le
 * poser contournerait la sonde en un clic, et le champ libre s'ouvrirait sur
 * le serveur d'un client.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))

const SORTIE_VIDE = [
  'vhosts=0',
  'fichiers=0',
  'bases_mysql=0',
  'bases_pg=0',
  'journaux=0',
  'sonde=complete',
].join('\n')

const executor: OpsExecutor = {
  kind: 'faux',
  executer: async () => ({ code: 0, stdout: SORTIE_VIDE, stderr: '' }),
}
const http: SondeHttp = async () => ({ erreur: 'connect ECONNREFUSED 203.0.113.10:443' })

const app = await buildApp({ db, opsExecutor: executor, opsHttp: http })

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

beforeEach(async () => {
  await db.deleteFrom('serveurs').execute()
})

function req(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
  const base = { method, url, cookies: { hm_session: cookie } } as const
  return payload === undefined ? app.inject(base) : app.inject({ ...base, payload })
}

const NEUF = {
  nom: 'ovh-neuf',
  hote: '203.0.113.10',
  utilisateur: 'silithid',
  url: 'https://neuf.test',
}

test('les routes exigent une session', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/serveurs' })).statusCode).toBe(401)
  expect(
    (await app.inject({ method: 'POST', url: '/api/serveurs', payload: NEUF })).statusCode,
  ).toBe(401)
})

test('un serveur enregistré est « inconnu », et rien ne permet de dire autre chose', async () => {
  const res = await req('POST', '/api/serveurs', NEUF)
  expect(res.statusCode).toBe(201)
  expect(res.json().etat).toBe('inconnu')

  // Aucune route ne pose un état : ni à la création, ni ensuite. Le champ
  // « etat » envoyé par un client est simplement ignoré par le schéma.
  const force = await req('POST', '/api/serveurs', {
    ...NEUF,
    nom: 'ovh-force',
    etat: 'vierge',
    etat_mesure_at: new Date().toISOString(),
  })
  expect(force.json().etat).toBe('inconnu')
})

test('un nom qui casserait la portée de la clé de coffre est refusé', async () => {
  for (const nom of ['ovh.neuf', 'OVH', 'ovh neuf', '../x']) {
    const res = await req('POST', '/api/serveurs', { ...NEUF, nom })
    expect(res.statusCode, nom).toBe(400)
  }
})

test('deux serveurs ne peuvent pas porter le même nom', async () => {
  expect((await req('POST', '/api/serveurs', NEUF)).statusCode).toBe(201)
  expect((await req('POST', '/api/serveurs', NEUF)).statusCode).toBe(409)
})

test('la sonde mesure et persiste, avec ses preuves', async () => {
  const id = (await req('POST', '/api/serveurs', NEUF)).json().id

  const res = await req('POST', `/api/serveurs/${id}/sonde`)
  expect(res.statusCode).toBe(200)
  expect(res.json().etat).toBe('vierge')

  const detail = (await req('GET', `/api/serveurs/${id}`)).json()
  expect(detail.etat).toBe('vierge')
  // Un verdict sans ses preuves ne se conteste pas — et c'est ce verdict qui
  // décide de l'autonomie de l'agent.
  expect(detail.preuves).toHaveLength(5)
  expect(detail.etatMesureAt).not.toBeNull()
})

test('demander un plan sur un serveur jamais mesuré est refusé', async () => {
  const id = (await req('POST', '/api/serveurs', NEUF)).json().id

  const res = await req('POST', `/api/serveurs/${id}/plan`, {
    projectId: randomUUID(),
    besoin: 'Installer ce qu’il faut pour servir le site.',
  })
  // Refus net plutôt qu'une sonde implicite : mesurer touche le serveur, ça se
  // demande.
  expect(res.statusCode).toBe(409)
  expect(res.json().error).toBe('etat_inconnu')
})

test('la liste dit qu’un accès existe, jamais ce qu’il vaut', async () => {
  await req('POST', '/api/serveurs', NEUF)
  const settings = createSettingsStore(db, await createSecretBox(env.MASTER_KEY))
  await settings.setSecret(cleCoffre('ovh-neuf', 'ssh_private_key'), 'NE-DOIT-JAMAIS-SORTIR')

  const res = await req('GET', '/api/serveurs')
  const ligne = res.json()[0]
  expect(ligne.accesDepose).toBe(true)
  expect(ligne.cleCoffre).toBe('ops.ovh-neuf.ssh_private_key')
  // Cherché dans le corps entier : une fuite par un champ oublié doit faire
  // échouer ce test.
  expect(res.body).not.toContain('NE-DOIT-JAMAIS-SORTIR')
})

test('un serveur inconnu rend 404, pas une fiche vide', async () => {
  expect((await req('GET', `/api/serveurs/${randomUUID()}`)).statusCode).toBe(404)
  expect((await req('POST', `/api/serveurs/${randomUUID()}/sonde`)).statusCode).toBe(404)
})

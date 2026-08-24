import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createSecretBox } from '../src/crypto/secrets'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import {
  AccesServeurManquantError,
  cleCoffre,
  inventaireAcces,
  lireAcces,
} from '../src/ops/credentials'
import { createSettingsStore } from '../src/settings/store'

/**
 * Les accès aux serveurs (Phase 6, Task 6).
 *
 * Un jeu par serveur, jamais un passe-partout : une clé unique ferait de la
 * compromission d'un seul serveur celle de tous les clients de Florian d'un
 * coup. Ce fichier vérifie la portée, et qu'aucune valeur ne sort de l'API.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const app = await buildApp({ db })

let cookie: string
let settings: Awaited<ReturnType<typeof creerStore>>

async function creerStore() {
  return createSettingsStore(db, await createSecretBox(env.MASTER_KEY))
}

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await createUser(db, 'florian', 'motdepasse-de-test')
  settings = await creerStore()
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

const CLE_PRIVEE = '-----BEGIN OPENSSH PRIVATE KEY-----\nNE-DOIT-JAMAIS-SORTIR\n-----END-----'

async function creerServeur(nom: string): Promise<void> {
  await db
    .insertInto('serveurs')
    .values({ nom, hote: '203.0.113.10', utilisateur: 'silithid' })
    .execute()
}

test('la clé de coffre porte le nom du serveur : c’est ça, la portée', () => {
  expect(cleCoffre('ovh-vps', 'ssh_private_key')).toBe('ops.ovh-vps.ssh_private_key')
  // Deux serveurs, deux clés. Rien ne les fait se rejoindre.
  expect(cleCoffre('client-bastide', 'ssh_private_key')).not.toBe(
    cleCoffre('ovh-vps', 'ssh_private_key'),
  )
})

test('un nom hors forme lève, il n’est jamais nettoyé en silence', () => {
  // Un point changerait la portée : `ops.a.b.ssh_private_key` n'appartient
  // plus au serveur qu'on croit. Deux noms qui se nettoieraient en la même
  // clé partageraient un accès.
  for (const nom of ['a.b', 'OVH', 'vps/../autre', '', 'x'.repeat(80), 'nom avec espace']) {
    expect(() => cleCoffre(nom, 'ssh_private_key'), nom).toThrow(/invalide/)
  }
})

test('un serveur sans accès déposé lève, il ne se rabat sur rien', async () => {
  await creerServeur('sans-cle')
  await expect(lireAcces(settings, 'sans-cle')).rejects.toThrow(AccesServeurManquantError)
  // Le message dit où déposer la clé ET que sa portée est limitée.
  await expect(lireAcces(settings, 'sans-cle')).rejects.toThrow(/ops\.sans-cle\.ssh_private_key/)
})

test('un agent ne peut pas atteindre l’accès d’un autre serveur', async () => {
  await creerServeur('serveur-a')
  await creerServeur('serveur-b')
  await settings.setSecret(cleCoffre('serveur-a', 'ssh_private_key'), CLE_PRIVEE)

  expect((await lireAcces(settings, 'serveur-a')).clePrivee).toBe(CLE_PRIVEE)
  // Déposer une clé pour A ne donne rien sur B : il n'existe aucun repli.
  await expect(lireAcces(settings, 'serveur-b')).rejects.toThrow(AccesServeurManquantError)
})

test('l’inventaire dit qu’un accès existe, jamais ce qu’il vaut', async () => {
  await creerServeur('avec-cle')
  await creerServeur('sans-cle')
  await settings.setSecret(cleCoffre('avec-cle', 'ssh_private_key'), CLE_PRIVEE)

  const inv = await inventaireAcces(db, settings)
  expect(inv.map((e) => [e.serveur, e.depose])).toEqual([
    ['avec-cle', true],
    ['sans-cle', false],
  ])
  // Cherché dans la sérialisation ENTIÈRE : une fuite par un champ oublié doit
  // faire échouer ce test.
  expect(JSON.stringify(inv)).not.toContain('NE-DOIT-JAMAIS-SORTIR')
  expect(inv[0]?.portee).toBe('serveur avec-cle')
})

test('aucune clé de serveur ne sort par l’API du coffre', async () => {
  await creerServeur('ovh-vps')
  await settings.setSecret(cleCoffre('ovh-vps', 'ssh_private_key'), CLE_PRIVEE)

  const res = await app.inject({
    method: 'GET',
    url: '/api/vault',
    cookies: { hm_session: cookie },
  })

  // L'inventaire du coffre liste la clé — c'est son rôle — mais jamais sa valeur.
  expect(res.json()).toContainEqual({ key: 'ops.ovh-vps.ssh_private_key' })
  expect(res.body).not.toContain('NE-DOIT-JAMAIS-SORTIR')
  expect(res.body).not.toContain('BEGIN OPENSSH')
})

test('deux serveurs, deux entrées distinctes dans le coffre', async () => {
  await creerServeur(`srv-${randomUUID().slice(0, 6)}`)
  await settings.setSecret(cleCoffre('ovh-vps', 'ssh_private_key'), 'A')
  await settings.setSecret(cleCoffre('client-bastide', 'ssh_private_key'), 'B')

  expect(await settings.getSecret('ops.ovh-vps.ssh_private_key')).toBe('A')
  expect(await settings.getSecret('ops.client-bastide.ssh_private_key')).toBe('B')
})

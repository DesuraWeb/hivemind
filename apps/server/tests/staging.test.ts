import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createSecretBox } from '../src/crypto/secrets'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import {
  STAGING_KEY_SECRET,
  STAGING_SETTINGS_KEYS,
  readStagingConfig,
  stagingUrl,
} from '../src/deploy/ssh-git'
import { databaseUrl, loadEnv } from '../src/env'
import { type SettingsStore, createSettingsStore } from '../src/settings/store'

/**
 * Aucune connexion SSH n'est ouverte ici : on teste la lecture de
 * configuration et la dérivation d'URL. Le déploiement lui-même parle à un
 * vrai serveur, il se vérifie à la mise en service, pas dans une suite qui
 * doit tourner hors ligne.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
let settings: SettingsStore

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  settings = createSettingsStore(db, await createSecretBox(env.MASTER_KEY))
})

afterAll(async () => {
  await db.destroy()
})

async function clear(): Promise<void> {
  await db.deleteFrom('settings').execute()
}

test("rien de configuré : le staging n'est pas en service, ce n'est pas une erreur", async () => {
  await clear()
  // Un projet sans hébergement de recette est un cas normal : on retombe sur
  // l'aperçu local, sans rien casser.
  expect(await readStagingConfig(settings)).toBeNull()
})

test('configuration partielle : ça LÈVE, ça ne retombe pas en silence sur le local', async () => {
  await clear()
  await settings.set(STAGING_SETTINGS_KEYS.host, 'vps.silithid.com')
  await settings.set(STAGING_SETTINGS_KEYS.user, 'deploy')

  // Le piège qu'on refuse : sans ça, le juge capturerait une page servie en
  // local en croyant regarder le staging, et personne ne le verrait.
  await expect(readStagingConfig(settings)).rejects.toThrow(/incomplète/)

  // Le message nomme précisément ce qui manque, y compris le secret.
  await expect(readStagingConfig(settings)).rejects.toThrow(STAGING_KEY_SECRET)
  await expect(readStagingConfig(settings)).rejects.toThrow(STAGING_SETTINGS_KEYS.domain)
})

test('configuration complète : la clé privée vient du coffre, jamais des réglages', async () => {
  await clear()
  await settings.set(STAGING_SETTINGS_KEYS.host, 'vps.silithid.com')
  await settings.set(STAGING_SETTINGS_KEYS.user, 'deploy')
  await settings.set(STAGING_SETTINGS_KEYS.root, '/srv/staging')
  await settings.set(STAGING_SETTINGS_KEYS.domain, 'stg.silithid.com')
  await settings.setSecret(STAGING_KEY_SECRET, '-----BEGIN OPENSSH PRIVATE KEY-----\nfaux\n')

  const config = await readStagingConfig(settings)
  expect(config).not.toBeNull()
  expect(config?.host).toBe('vps.silithid.com')
  expect(config?.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY')

  // La clé est scellée en base : `listPublic` la masque, `get` ne la rend pas.
  const publics = await settings.listPublic()
  expect(publics[STAGING_KEY_SECRET]).toBe('***')
  expect(await settings.get(STAGING_KEY_SECRET)).toBeUndefined()
})

test("l'URL de staging est un sous-domaine par projet, en HTTPS", async () => {
  // Un enregistrement DNS joker suffit : un projet neuf a son URL sans que
  // personne ne touche à la DNS.
  expect(stagingUrl('stg.silithid.com', 'koin')).toBe('https://koin.stg.silithid.com')
  expect(stagingUrl('stg.silithid.com', 'client-bastide')).toBe(
    'https://client-bastide.stg.silithid.com',
  )
})

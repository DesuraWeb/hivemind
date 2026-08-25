import { expect, test } from 'vitest'
import { databaseUrl, loadEnv } from '../src/env'

test('loadEnv lit .env et fournit les clés requises', () => {
  const env = loadEnv()
  expect(env.MASTER_KEY.length).toBeGreaterThan(0)
  expect(env.SESSION_SECRET.length).toBeGreaterThan(0)
})

test('databaseUrl bascule sur la base de test en NODE_ENV=test', () => {
  const env = loadEnv()
  expect(env.NODE_ENV).toBe('test')
  // On vérifie le comportement, pas un nom de base : la CI n'utilise pas
  // forcément les mêmes noms que le poste de dev.
  expect(databaseUrl(env)).toBe(env.DATABASE_URL_TEST)
})

test('databaseUrl prend DATABASE_URL hors test, et exige DATABASE_URL_TEST en test', () => {
  const base = { DATABASE_URL: 'postgres://x/prod', MASTER_KEY: 'k', SESSION_SECRET: 's' }

  expect(databaseUrl(loadEnv({ ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv))).toBe(
    'postgres://x/prod',
  )
  expect(() => databaseUrl(loadEnv({ ...base, NODE_ENV: 'test' } as NodeJS.ProcessEnv))).toThrow(
    /DATABASE_URL_TEST/,
  )
})

test('une source explicite court-circuite .env et rejette une config invalide', () => {
  expect(() => loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/)
})

test("l'écoute est locale par défaut, et s'ouvre seulement si on le demande", () => {
  const base = {
    DATABASE_URL: 'postgres://x',
    MASTER_KEY: 'k',
    SESSION_SECRET: 's',
  } as NodeJS.ProcessEnv

  // Le défaut protège une installation dont personne n'a encore réglé le
  // réseau : derrière un reverse proxy, écouter sur 0.0.0.0 permet d'atteindre
  // l'app en contournant nginx, son TLS et son authentification. Constaté sur
  // le VPS de l'agence, où aucun pare-feu n'était posé.
  expect(loadEnv(base).HOST).toBe('127.0.0.1')

  // Un conteneur en a besoin, et le demande explicitement.
  expect(loadEnv({ ...base, HOST: '0.0.0.0' } as NodeJS.ProcessEnv).HOST).toBe('0.0.0.0')
})

test('le Chromium du système est optionnel, et absent par défaut', () => {
  const base = {
    DATABASE_URL: 'postgres://x',
    MASTER_KEY: 'k',
    SESSION_SECRET: 's',
  } as NodeJS.ProcessEnv

  // Absente, rien ne change : Playwright utilise son navigateur habituel.
  expect(loadEnv(base).CHROMIUM_EXECUTABLE_PATH).toBeUndefined()
  expect(
    loadEnv({ ...base, CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium' } as NodeJS.ProcessEnv)
      .CHROMIUM_EXECUTABLE_PATH,
  ).toBe('/usr/bin/chromium')
})

test('une configuration invalide dit OÙ le .env a été cherché', () => {
  // Sans ça, un script lancé hors du dépôt échoue sur « Configuration
  // invalide » sans le moindre indice : `findRepoRoot` remonte depuis le
  // répertoire COURANT, donc le fichier n'est pas trouvé et la cause a l'air
  // d'être la configuration elle-même. Remonté après une vraie mise en service.
  expect(() => loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toThrow(
    /source explicite, aucun \.env lu/,
  )
})

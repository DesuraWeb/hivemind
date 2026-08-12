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

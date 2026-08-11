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
  expect(databaseUrl(env)).toContain('hivemind_test')
})

test('une source explicite court-circuite .env et rejette une config invalide', () => {
  expect(() => loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/)
})

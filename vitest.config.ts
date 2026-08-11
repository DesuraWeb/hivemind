import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/server/tests/**/*.test.ts'],
    // `.env` est chargé par loadEnv() lui-même ; on ne force ici que ce qui
    // doit différer en test.
    env: {
      NODE_ENV: 'test',
      // Aucun test n'appelle un vrai modèle : la suite ne consomme pas de tokens.
      RUNTIME_ADAPTER: 'fake',
    },
    fileParallelism: false, // les tests partagent une base Postgres
    hookTimeout: 30_000,
  },
})

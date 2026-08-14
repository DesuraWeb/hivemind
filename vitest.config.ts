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
    fileParallelism: false, // les fichiers d'un même processus partagent la base
    // Verrou consultatif : sérialise aussi entre PROCESSUS. Plusieurs sessions
    // lancent `pnpm test` en même temps sur ce dépôt, et chaque fichier
    // commence par un `drop schema`. Voir apps/server/tests/setup.ts.
    setupFiles: ['./apps/server/tests/setup.ts'],
    hookTimeout: 30_000,
  },
})

import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { authRoutes } from './api/routes/auth'
import { healthRoutes } from './api/routes/health'
import { settingsRoutes } from './api/routes/settings'
import { registerSession } from './auth/session'
import { createSecretBox } from './crypto/secrets'
import type { Database } from './db/types'
import { loadEnv } from './env'
import { createSettingsStore } from './settings/store'

export interface AppDeps {
  db: Kysely<Database>
}

/** Construit l'instance Fastify sans l'écouter — utilisable tel quel en test. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const env = loadEnv()
  const app = Fastify({ logger: env.NODE_ENV !== 'test' })
  const settings = createSettingsStore(deps.db, await createSecretBox(env.MASTER_KEY))

  await registerSession(app, { db: deps.db, secret: env.SESSION_SECRET })
  await app.register(healthRoutes)
  await app.register(authRoutes, { db: deps.db })
  await app.register(settingsRoutes, { settings })

  return app
}

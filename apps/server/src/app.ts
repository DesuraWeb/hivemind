import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { authRoutes } from './api/routes/auth'
import { healthRoutes } from './api/routes/health'
import { registerSession } from './auth/session'
import type { Database } from './db/types'
import { loadEnv } from './env'

export interface AppDeps {
  db: Kysely<Database>
}

/** Construit l'instance Fastify sans l'écouter — utilisable tel quel en test. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const env = loadEnv()
  const app = Fastify({ logger: env.NODE_ENV !== 'test' })

  await registerSession(app, { db: deps.db, secret: env.SESSION_SECRET })
  await app.register(healthRoutes)
  await app.register(authRoutes, { db: deps.db })

  return app
}

import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { authRoutes } from './api/routes/auth'
import { healthRoutes } from './api/routes/health'
import { settingsRoutes } from './api/routes/settings'
import { registerSession } from './auth/session'
import { createSecretBox } from './crypto/secrets'
import type { Database } from './db/types'
import { loadEnv } from './env'
import { type Mailer, createMailer } from './integrations/mailer'
import { createRuntimeAdapter } from './runtime/index'
import type { RuntimeAdapter } from './runtime/types'
import { createSettingsStore } from './settings/store'

export interface AppDeps {
  db: Kysely<Database>
  /**
   * Réutilisés tels quels s'ils sont fournis, au lieu d'en construire une
   * nouvelle instance. `index.ts` en a besoin pour pg-boss (le worker
   * `auth.healthcheck` doit partager le même `ClaudeAdapter` que la route
   * HTTP : `usage()` renvoie la dernière mesure vue en mémoire sur
   * l'instance, deux instances divergeraient). Les tests, qui n'en passent
   * pas, gardent le comportement d'avant : une instance construite ici.
   */
  adapter?: RuntimeAdapter
  mailer?: Mailer
}

/** Construit l'instance Fastify sans l'écouter — utilisable tel quel en test. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const env = loadEnv()
  const app = Fastify({ logger: env.NODE_ENV !== 'test' })
  const settings = createSettingsStore(deps.db, await createSecretBox(env.MASTER_KEY))
  const adapter = deps.adapter ?? (await createRuntimeAdapter(env))
  const mailer = deps.mailer ?? createMailer(env)

  await registerSession(app, { db: deps.db, secret: env.SESSION_SECRET })
  await app.register(healthRoutes, {
    db: deps.db,
    adapter,
    mailer,
    alertTo: env.ALERT_EMAIL_TO ?? 'alerts@exemple.test',
  })
  await app.register(authRoutes, { db: deps.db })
  await app.register(settingsRoutes, { settings })

  return app
}

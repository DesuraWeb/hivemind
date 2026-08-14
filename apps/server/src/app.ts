import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { eventsRoutes } from './api/events'
import { analyticsRoutes } from './api/routes/analytics'
import { authRoutes } from './api/routes/auth'
import { budgetRoutes } from './api/routes/budget'
import { clientsRoutes } from './api/routes/clients'
import { globesRoutes } from './api/routes/globes'
import { healthRoutes } from './api/routes/health'
import { hiveRoutes } from './api/routes/hive'
import { inboxRoutes } from './api/routes/inbox'
import { journalRoutes } from './api/routes/journal'
import { projectsRoutes } from './api/routes/projects'
import { rolesRoutes } from './api/routes/roles'
import { runsRoutes } from './api/routes/runs'
import { settingsRoutes } from './api/routes/settings'
import { registerSession } from './auth/session'
import { createSecretBox } from './crypto/secrets'
import type { Database } from './db/types'
import { loadEnv } from './env'
import { type GmailSendPort, createLazyGmailSender } from './integrations/gmail'
import { type Mailer, createMailer } from './integrations/mailer'
import { createBoss } from './jobs/boss'
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
  /**
   * `POST /api/inbox/:id/resolve` (Task 4) ré-enfile le job `run.step` via
   * `resolveInboxItem`, qui a besoin d'une instance pg-boss. `index.ts` la
   * construit avec `createBoss(env)` (non démarrée) puis appelle `startBoss`
   * APRÈS `buildApp`, exactement comme il le fait déjà pour le worker
   * `run.step` lui-même — `createBoss` ne fait que construire l'objet, la
   * démarrer est un choix séparé qui reste à `index.ts`. Les tests qui
   * exercent réellement la résolution d'un item bloquant doivent passer une
   * instance démarrée (cf. tests/inbox.test.ts pour le même besoin côté
   * `resolveInboxItem` directement) ; ceux qui n'exercent que les autres
   * routes peuvent laisser `buildApp` construire une instance non démarrée
   * par défaut, jamais utilisée.
   */
  boss?: PgBoss
  /**
   * Port d'envoi Gmail (Task 5, Phase 5). Par défaut construit depuis le
   * coffre : tant qu'aucun secret Gmail n'y est déposé, c'est un compte
   * factice en mémoire et rien ne part. Les tests passent le leur pour
   * observer ce qui aurait été envoyé.
   */
  gmailSender?: GmailSendPort
}

/** Construit l'instance Fastify sans l'écouter — utilisable tel quel en test. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const env = loadEnv()
  const app = Fastify({ logger: env.NODE_ENV !== 'test' })
  const settings = createSettingsStore(deps.db, await createSecretBox(env.MASTER_KEY))
  const adapter = deps.adapter ?? (await createRuntimeAdapter(env))
  const mailer = deps.mailer ?? createMailer(env)
  const boss = deps.boss ?? createBoss(env)
  const gmailSender = deps.gmailSender ?? createLazyGmailSender(settings)

  await registerSession(app, { db: deps.db, secret: env.SESSION_SECRET })
  await app.register(healthRoutes, {
    db: deps.db,
    adapter,
    mailer,
    alertTo: env.ALERT_EMAIL_TO ?? 'alerts@exemple.test',
  })
  await app.register(authRoutes, { db: deps.db })
  await app.register(settingsRoutes, { settings })
  await app.register(eventsRoutes)
  await app.register(inboxRoutes, { db: deps.db, boss, adapter, settings, gmailSender })
  await app.register(projectsRoutes, { db: deps.db, settings })
  await app.register(globesRoutes, { db: deps.db })
  await app.register(budgetRoutes, { db: deps.db, settings, adapter, boss })
  await app.register(clientsRoutes, { db: deps.db })
  await app.register(rolesRoutes, { db: deps.db, settings })
  await app.register(analyticsRoutes, { db: deps.db, settings })
  await app.register(runsRoutes, { db: deps.db, boss })
  await app.register(journalRoutes, { db: deps.db })
  await app.register(hiveRoutes, { db: deps.db, adapter, cwd: env.WORKTREES_ROOT })

  return app
}

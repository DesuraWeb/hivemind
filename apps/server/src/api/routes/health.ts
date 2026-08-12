import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '../../db/types'
import { runAuthHealthcheck } from '../../health/auth-check'
import type { Mailer } from '../../integrations/mailer'
import type { RuntimeAdapter } from '../../runtime/types'

export interface HealthDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  mailer: Mailer
  alertTo: string
}

export async function healthRoutes(app: FastifyInstance, deps: HealthDeps): Promise<void> {
  // Volontairement non authentifiée : c'est la sonde de vie du process.
  app.get('/api/health', async () => ({ status: 'ok', at: new Date().toISOString() }))

  // Authentifiée : elle ouvre une session agent et peut lever une alerte.
  app.get('/api/health/auth', { preHandler: app.requireAuth }, async () => runAuthHealthcheck(deps))
}

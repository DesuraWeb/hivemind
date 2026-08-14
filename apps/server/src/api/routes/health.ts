import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '../../db/types'
import { runAuthHealthcheck } from '../../health/auth-check'
import { readSystemStatus } from '../../health/system'
import type { Mailer } from '../../integrations/mailer'
import type { RuntimeAdapter } from '../../runtime/types'
import type { SettingsStore } from '../../settings/store'

export interface HealthDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  mailer: Mailer
  alertTo: string
  /** Seuils de budget et état de la réserve, pour le bandeau de dégradation. */
  settings: SettingsStore
}

export async function healthRoutes(app: FastifyInstance, deps: HealthDeps): Promise<void> {
  // Volontairement non authentifiée : c'est la sonde de vie du process.
  app.get('/api/health', async () => ({ status: 'ok', at: new Date().toISOString() }))

  // Authentifiée : elle ouvre une session agent et peut lever une alerte.
  app.get('/api/health/auth', { preHandler: app.requireAuth }, async () => runAuthHealthcheck(deps))

  /**
   * L'état du système pour le bandeau de dégradation.
   *
   * Gratuite, contrairement à `/api/health/auth` : elle LIT les alertes déjà
   * levées par le cron au lieu de refaire le contrôle, et la jauge de budget
   * ne consomme rien. Elle peut donc être appelée à chaque page.
   *
   * Rend une liste vide la plupart du temps : « le système ne parle que quand
   * quelque chose se dégrade » (Etats systeme.dc.html).
   */
  app.get('/api/system/status', { preHandler: app.requireAuth }, async () =>
    readSystemStatus({ db: deps.db, settings: deps.settings, adapter: deps.adapter }),
  )
}

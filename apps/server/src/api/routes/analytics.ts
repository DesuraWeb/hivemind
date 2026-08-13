import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { getAnalytics, getStepCosts } from '../../analytics/repo'
import type { Database } from '../../db/types'
import type { SettingsStore } from '../../settings/store'

export interface AnalyticsRoutesDeps {
  db: Kysely<Database>
  settings: SettingsStore
}

/** Même repli que `projects.ts` : un ordre de grandeur d'affichage, jamais une facturation. */
const DEFAULT_EUR_PER_MTOK = 15

/** Fenêtre par défaut : les 30 barres quotidiennes du pack (`Analytics.dc.html`). */
const DEFAULT_DAYS = 30
/** Un an. Au-delà, la série ne se lit plus et la requête grossit pour rien. */
const MAX_DAYS = 365

const query = z.object({ days: z.coerce.number().int().min(1).max(MAX_DAYS).optional() })
const params = z.object({ id: z.string().min(1) })

export async function analyticsRoutes(
  app: FastifyInstance,
  deps: AnalyticsRoutesDeps,
): Promise<void> {
  async function rate(): Promise<number> {
    const value = await deps.settings.get<number>('pricing.eur_per_mtok')
    return typeof value === 'number' ? value : DEFAULT_EUR_PER_MTOK
  }

  app.get('/api/analytics', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = query.safeParse(req.query)
    // Une fenêtre absurde est refusée, pas silencieusement ramenée au défaut :
    // l'appelant croirait lire 400 jours et en lirait 30.
    if (!parsed.success) return reply.code(400).send({ error: 'days_invalide' })
    return getAnalytics(deps.db, await rate(), parsed.data.days ?? DEFAULT_DAYS)
  })

  app.get('/api/analytics/steps/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = params.safeParse(req.params)
    if (!parsed.success) return reply.code(400).send({ error: 'id_invalide' })
    return getStepCosts(deps.db, await rate(), parsed.data.id)
  })
}

import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from '../../db/types'
import {
  getProjectBySlug,
  getProjectIdBySlug,
  listProjects,
  listRuns,
  listSteps,
} from '../../projects/repo'
import type { SettingsStore } from '../../settings/store'

export interface ProjectsRoutesDeps {
  db: Kysely<Database>
  settings: SettingsStore
}

const params = z.object({ id: z.string().min(1) })

/**
 * Taux de conversion tokens → euros (`settings['pricing.eur_per_mtok']`,
 * seedé à 15 par `seedDefaultSettings`). Si le réglage est absent — base
 * fraîchement migrée sans seed —, on retombe sur la même valeur par défaut
 * plutôt que de planter `GET /api/projects` : c'est un ordre de grandeur
 * d'affichage, jamais une valeur de facturation (cf. seed.ts).
 */
const DEFAULT_EUR_PER_MTOK = 15

async function eurPerMtok(settings: SettingsStore): Promise<number> {
  const value = await settings.get<number>('pricing.eur_per_mtok')
  return typeof value === 'number' ? value : DEFAULT_EUR_PER_MTOK
}

export async function projectsRoutes(
  app: FastifyInstance,
  deps: ProjectsRoutesDeps,
): Promise<void> {
  app.get('/api/projects', { preHandler: app.requireAuth }, async () => {
    const rate = await eurPerMtok(deps.settings)
    return listProjects(deps.db, rate)
  })

  app.get('/api/projects/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = params.safeParse(req.params)
    if (!parsed.success) return reply.code(400).send({ error: 'id_invalide' })

    const rate = await eurPerMtok(deps.settings)
    const project = await getProjectBySlug(deps.db, rate, parsed.data.id)
    if (!project) return reply.code(404).send({ error: 'projet_introuvable' })
    return project
  })

  app.get('/api/projects/:id/steps', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = params.safeParse(req.params)
    if (!parsed.success) return reply.code(400).send({ error: 'id_invalide' })

    const projectId = await getProjectIdBySlug(deps.db, parsed.data.id)
    if (!projectId) return reply.code(404).send({ error: 'projet_introuvable' })
    return listSteps(deps.db, projectId)
  })

  app.get('/api/projects/:id/runs', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = params.safeParse(req.params)
    if (!parsed.success) return reply.code(400).send({ error: 'id_invalide' })

    const projectId = await getProjectIdBySlug(deps.db, parsed.data.id)
    if (!projectId) return reply.code(404).send({ error: 'projet_introuvable' })
    return listRuns(deps.db, projectId)
  })
}

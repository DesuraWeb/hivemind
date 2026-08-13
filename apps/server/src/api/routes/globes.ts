import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from '../../db/types'
import { createGlobe, listGlobes } from '../../globes/repo'

export interface GlobesRoutesDeps {
  db: Kysely<Database>
}

/**
 * `color` : chaîne CSS libre (hex ou `var(--...)`, comme `projects.tint`) —
 * pas de validation de format ici, c'est un affichage, pas une valeur qui
 * pilote une décision de sécurité. Champ absent ou vide traité comme absent.
 */
const createBody = z.object({
  name: z.string().trim().min(1),
  color: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
})

/**
 * CRUD minimal (plan Phase 3, Task 8) : liste pour la page Globes (système
 * solaire) et création par formulaire simple — la création conversationnelle
 * via Hive est une clause de débordement explicite du plan, pas construite
 * ici. Pas de PATCH/DELETE : hors du périmètre « minimal » demandé.
 */
export async function globesRoutes(app: FastifyInstance, deps: GlobesRoutesDeps): Promise<void> {
  app.get('/api/globes', { preHandler: app.requireAuth }, async () => listGlobes(deps.db))

  app.post('/api/globes', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'requete_invalide' })

    // zod garde `color` comme clé présente typée `string | undefined` même après
    // `.optional()` — incompatible avec `exactOptionalPropertyTypes` et
    // `CreateGlobeInput.color?: string | null` (globes/repo.ts). Même parade que
    // `toInboxResponse` (api/routes/inbox.ts) : on n'inclut la clé que si fournie.
    const { name, color } = parsed.data
    const globe = await createGlobe(deps.db, color !== undefined ? { name, color } : { name })
    return reply.code(201).send(globe)
  })
}

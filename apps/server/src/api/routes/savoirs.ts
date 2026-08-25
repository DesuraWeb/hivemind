import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from '../../db/types'
import { apercuMemoire } from '../../knowledge/apercu'
import { archiverPerime, fileDeRevue, garder } from '../../knowledge/review'

export interface SavoirsRoutesDeps {
  db: Kysely<Database>
}

/**
 * `racine_id` est un uuid : un identifiant malformé arriverait jusqu'à
 * Postgres en `22P02` et remonterait en 500. Refusé ici, en 400 : ce n'est pas
 * une panne du serveur.
 */
const racineParams = z.object({ racineId: z.string().uuid() })

/**
 * La revue de péremption (`docs/design/Revue des savoirs.dc.html`).
 *
 * Trois routes, aucun appel de modèle : la file est un `select` trié, et la
 * phrase de Hive est calculée depuis les mêmes nombres (cf.
 * `knowledge/review.ts`, `phraseHive`). Ouvrir l'écran ne coûte donc rien.
 */
export async function savoirsRoutes(app: FastifyInstance, deps: SavoirsRoutesDeps): Promise<void> {
  /**
   * L'état de la mémoire, pour l'écran `/conscience`. Des comptes, jamais du
   * contenu en vrac : le contenu se lit dans la revue, savoir par savoir.
   */
  app.get('/api/savoirs/apercu', { preHandler: app.requireAuth }, async () => {
    return apercuMemoire(deps.db)
  })

  app.get('/api/savoirs/revue', { preHandler: app.requireAuth }, async () => {
    return fileDeRevue(deps.db)
  })

  app.post('/api/savoirs/:racineId/garder', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = racineParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'racine_invalide' })

    const revueAt = await garder(deps.db, params.data.racineId)
    // Aucun savoir ACTIF sous cette racine : soit elle n'existe pas, soit il a
    // été archivé entre-temps (autre onglet). Dans les deux cas le geste n'a
    // rien confirmé, et l'écran doit le dire plutôt que faire disparaître une
    // carte pour rien.
    if (!revueAt) return reply.code(404).send({ error: 'savoir_introuvable' })

    return { racineId: params.data.racineId, revueAt: revueAt.toISOString() }
  })

  app.post(
    '/api/savoirs/:racineId/archiver',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const params = racineParams.safeParse(req.params)
      if (!params.success) return reply.code(400).send({ error: 'racine_invalide' })

      const fait = await archiverPerime(deps.db, params.data.racineId)
      if (!fait) return reply.code(404).send({ error: 'savoir_introuvable' })

      return { racineId: params.data.racineId, archive: true }
    },
  )
}

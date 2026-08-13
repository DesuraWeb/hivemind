import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { getClient, listClients } from '../../clients/repo'
import type { Database } from '../../db/types'

export interface ClientsRoutesDeps {
  db: Kysely<Database>
}

const params = z.object({ id: z.string().min(1) })

/**
 * Les fiches clients. `apps/web/src/routes/Clients.tsx` n'affiche aujourd'hui
 * qu'un titre, faute d'API : c'est ce qui manquait.
 *
 * Rappel de ce que `clients/repo.ts` garantit : **aucune valeur de secret ne
 * transite par ces routes**, seulement les noms des accès détenus.
 */
export async function clientsRoutes(app: FastifyInstance, deps: ClientsRoutesDeps): Promise<void> {
  app.get('/api/clients', { preHandler: app.requireAuth }, async () => {
    return listClients(deps.db)
  })

  app.get('/api/clients/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = params.safeParse(req.params)
    if (!parsed.success) return reply.code(400).send({ error: 'id_invalide' })

    const client = await getClient(deps.db, parsed.data.id)
    if (!client) return reply.code(404).send({ error: 'client_introuvable' })
    return client
  })
}

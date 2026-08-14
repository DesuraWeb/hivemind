import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from '../../db/types'
import { askHive, listHiveMessages } from '../../hive/conversation'
import type { RuntimeAdapter } from '../../runtime/types'

export interface HiveRoutesDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  /** Répertoire de travail des sessions Hive. Aucun accès fichier n'est accordé, le SDK en exige un. */
  cwd: string
}

const askBody = z.object({
  // Borné : un message de plusieurs pages coûterait cher sans rien apporter,
  // et ce n'est pas la voie pour transmettre un document.
  text: z.string().min(1).max(4000),
})

/**
 * Le fil de conversation avec Hive. Écrire dans le champ pilule du bandeau ne
 * produisait rien depuis la Phase 3 : le champ existait, le rôle existait,
 * rien ne les reliait.
 */
export async function hiveRoutes(app: FastifyInstance, deps: HiveRoutesDeps): Promise<void> {
  app.get('/api/hive/messages', { preHandler: app.requireAuth }, async () => {
    return listHiveMessages(deps.db)
  })

  app.post('/api/hive/messages', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = askBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'message_invalide' })

    try {
      return await askHive({ db: deps.db, adapter: deps.adapter, cwd: deps.cwd }, parsed.data.text)
    } catch (err) {
      // Le message de Florian est déjà écrit en base à ce stade : il n'est pas
      // perdu, et l'écran peut le réafficher. On dit que la réponse a échoué,
      // pas que la question n'a pas été posée.
      return reply.code(502).send({
        error: 'hive_indisponible',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  })
}

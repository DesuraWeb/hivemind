import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from '../../db/types'
import { JOURNAL_RETENTION_DAYS, listDecisions, listNight } from '../../journal/repo'

export interface JournalRoutesDeps {
  db: Kysely<Database>
}

/** Fenêtre par défaut : la dernière journée, ce que Florian lit le matin. */
const DEFAULT_HOURS = 24

const query = z.object({
  /** Bornée par la rétention annoncée par l'écran : au-delà, il n'y a rien à promettre. */
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(JOURNAL_RETENTION_DAYS * 24)
    .optional(),
})

export async function journalRoutes(app: FastifyInstance, deps: JournalRoutesDeps): Promise<void> {
  app.get('/api/journal', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = query.safeParse(req.query)
    // Refusé plutôt que ramené au défaut : l'appelant croirait lire un an et
    // lirait un jour.
    if (!parsed.success) return reply.code(400).send({ error: 'hours_invalide' })

    const until = new Date()
    const since = new Date(until.getTime() - (parsed.data.hours ?? DEFAULT_HOURS) * 3_600_000)
    const window = { since, until }

    // Les deux onglets en une requête : ils sont lus ensemble (l'écran a un
    // segmented control, pas deux pages), et chacun coûte une requête SQL
    // bornée. Deux allers-retours réseau pour ça n'apporteraient rien.
    const [night, decisions] = await Promise.all([
      listNight(deps.db, window),
      listDecisions(deps.db, window),
    ])

    return {
      window: { since: since.toISOString(), until: until.toISOString() },
      retentionDays: JOURNAL_RETENTION_DAYS,
      night,
      decisions,
    }
  })
}

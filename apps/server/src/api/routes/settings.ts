import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SettingsStore } from '../../settings/store'

const body = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  secret: z.boolean().default(false),
})

export async function settingsRoutes(app: FastifyInstance, opts: { settings: SettingsStore }) {
  app.get('/api/settings', { preHandler: app.requireAuth }, async () => opts.settings.listPublic())

  app.put('/api/settings', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'requete_invalide' })

    if (parsed.data.secret) {
      if (typeof parsed.data.value !== 'string') {
        return reply.code(400).send({ error: 'un_secret_doit_etre_une_chaine' })
      }
      await opts.settings.setSecret(parsed.data.key, parsed.data.value)
    } else {
      await opts.settings.set(parsed.data.key, parsed.data.value)
    }
    return { ok: true }
  })
}

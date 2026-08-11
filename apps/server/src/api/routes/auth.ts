import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { clearSessionCookie, setSessionCookie } from '../../auth/session'
import { authenticate } from '../../auth/users'
import type { Database } from '../../db/types'

const loginBody = z.object({ login: z.string().min(1), password: z.string().min(1) })

export async function authRoutes(app: FastifyInstance, opts: { db: Kysely<Database> }) {
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'requete_invalide' })

    const user = await authenticate(opts.db, parsed.data.login, parsed.data.password)
    if (!user) return reply.code(401).send({ error: 'identifiants_invalides' })

    setSessionCookie(reply, user.id)
    return { id: user.id, login: user.login }
  })

  app.post('/api/auth/logout', async (_req, reply) => {
    clearSessionCookie(reply)
    return { ok: true }
  })

  app.get('/api/me', { preHandler: app.requireAuth }, async (req) => req.user)
}

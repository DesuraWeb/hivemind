import cookie from '@fastify/cookie'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { findUserById } from './users'
import type { PublicUser } from './users'

const COOKIE = 'hm_session'

declare module 'fastify' {
  interface FastifyRequest {
    user?: PublicUser
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export async function registerSession(
  app: FastifyInstance,
  opts: { db: Kysely<Database>; secret: string },
): Promise<void> {
  await app.register(cookie, { secret: opts.secret })

  app.decorateRequest('user', undefined)

  // Résout l'utilisateur à partir du cookie signé, sur toutes les requêtes.
  app.addHook('preHandler', async (req) => {
    const raw = req.cookies[COOKIE]
    if (!raw) return
    const unsigned = req.unsignCookie(raw)
    if (!unsigned.valid || !unsigned.value) return
    const user = await findUserById(opts.db, unsigned.value)
    // `exactOptionalPropertyTypes` interdit d'assigner `undefined` explicitement
    // à une propriété optionnelle : ne pas assigner équivaut au même résultat
    // (req.user reste absent), la ligne ci-dessous ne change aucun comportement.
    if (user) req.user = user
  })

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: 'non_authentifie' })
    }
  })
}

export function setSessionCookie(reply: FastifyReply, userId: string): void {
  reply.setCookie(COOKIE, userId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30,
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' })
}

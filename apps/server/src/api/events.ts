import type { FastifyInstance } from 'fastify'
import { type BusEvent, eventBus } from '../events/bus'

/** Sinon les proxys (nginx, etc.) coupent une connexion qu'ils croient inactive. */
const HEARTBEAT_MS = 15_000

// Compteur exporté pour les tests uniquement : prouve qu'aucun timer de
// heartbeat ne survit à la fermeture de sa connexion (pas de fuite jumelle à
// celle des abonnés du bus).
let activeHeartbeats = 0
export function heartbeatCount(): number {
  return activeHeartbeats
}

function formatEvent(event: BusEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/**
 * `GET /api/events` : flux SSE unique et typé (brief §8). Authentifié comme
 * toute autre route ; jamais de boucle de polling côté front.
 *
 * Ce flux ne se termine jamais tant que le client reste connecté — on sort
 * donc du cycle de vie normal de Fastify (`reply.hijack()`) pour écrire nous-
 * mêmes sur la réponse HTTP brute.
 */
export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/events', { preHandler: app.requireAuth }, (req, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    // `writeHead` seul ne fait que mettre les en-têtes en attente : Node ne
    // les envoie sur le socket qu'au premier `write()`, qui n'arriverait sinon
    // qu'au premier événement ou, pire, au premier heartbeat 15 s plus tard.
    // Le client (EventSource, fetch) doit voir la connexion établie tout de
    // suite, pas quand quelque chose finit par se passer.
    reply.raw.flushHeaders()

    const unsubscribe = eventBus.subscribe((event) => {
      reply.raw.write(formatEvent(event))
    })

    activeHeartbeats++
    const heartbeat = setInterval(() => {
      // Commentaire SSE : une ligne qui commence par `:` est ignorée par le
      // client mais garde la connexion visiblement active pour les proxys.
      reply.raw.write(':\n\n')
    }, HEARTBEAT_MS)

    // Doit tourner exactement une fois par connexion : sinon deux appels de
    // `unsubscribe()` sont inoffensifs (idempotent), mais deux décréments de
    // `activeHeartbeats` pour un seul `clearInterval` fausseraient le compteur.
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearInterval(heartbeat)
      activeHeartbeats--
      unsubscribe()
    }

    // `close` sur la requête couvre le cas normal (client qui se déconnecte,
    // proxy qui coupe) ; `close` sur la réponse couvre le cas où c'est nous
    // qui terminons l'écriture. Les deux convergent vers le même cleanup
    // idempotent — aucune fuite d'abonné ni de timer, quel que soit le sens
    // de la fermeture.
    req.raw.on('close', cleanup)
    reply.raw.on('close', cleanup)
  })
}

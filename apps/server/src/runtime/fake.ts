import { randomUUID } from 'node:crypto'
import type {
  AgentResult,
  AgentSession,
  CreateSessionOptions,
  RuntimeAdapter,
  UsageSnapshot,
} from './types'

export interface FakeAdapterOptions {
  /** Réponses renvoyées dans l'ordre, une par appel à send(). */
  replies?: string[]
  usage?: { fiveHourPct: number; sevenDayPct: number }
}

/**
 * Adapter déterministe pour les tests et le développement hors ligne.
 * Ne fait aucun appel réseau et ne consomme aucun token.
 */
export function createFakeAdapter(opts: FakeAdapterOptions = {}): RuntimeAdapter {
  const sessions = new Map<
    string,
    { session: AgentSession; onEvent: CreateSessionOptions['onEvent'] }
  >()
  const replies = [...(opts.replies ?? [])]
  let cursor = 0

  return {
    async createSession(options) {
      const session: AgentSession = {
        id: `fake-${randomUUID()}`,
        roleKey: options.roleKey,
        cwd: options.cwd,
      }
      sessions.set(session.id, { session, onEvent: options.onEvent })
      return session
    },

    async send(session, message): Promise<AgentResult> {
      const entry = sessions.get(session.id)
      const text = replies[cursor++] ?? `[fake] réponse à : ${message}`
      const costTokens = message.length + text.length

      entry?.onEvent({ type: 'text', text })
      entry?.onEvent({ type: 'cost', tokens: costTokens })

      return { text, costTokens, isError: false }
    },

    async resume(sessionId) {
      return sessions.get(sessionId)?.session ?? null
    },

    async usage(): Promise<UsageSnapshot> {
      if (!opts.usage) return { fiveHourPct: 0, sevenDayPct: 0, available: false }
      return { ...opts.usage, available: true }
    },
  }
}

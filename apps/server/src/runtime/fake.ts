import { randomUUID } from 'node:crypto'
import type {
  AgentResult,
  AgentSession,
  CreateSessionOptions,
  RuntimeAdapter,
  UsageSnapshot,
} from './types'

/**
 * Simule un appel d'outil plutôt qu'une réponse en texte libre (Task 7) —
 * ce que le FakeAdapter renvoie quand on veut scripter le comportement
 * attendu du garant (appeler l'outil de sortie structurée) sans dépendre du
 * SDK réel ni consommer de tokens.
 */
export interface FakeToolCall {
  toolUse: { name: string; input: unknown }
}

export interface FakeAdapterOptions {
  /** Réponses renvoyées dans l'ordre, une par appel à send(). Texte libre ou appel d'outil scripté. */
  replies?: (string | FakeToolCall)[]
  usage?: { fiveHourPct: number; sevenDayPct: number }
  /** Si défini, `healthcheck()` échoue avec ce message — simule une auth cassée. */
  healthcheckError?: string
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
    async healthcheck() {
      if (opts.healthcheckError) {
        return { ok: false, latencyMs: 0, error: opts.healthcheckError }
      }
      return { ok: true, latencyMs: 0 }
    },

    async createSession(options) {
      const session: AgentSession = {
        id: `fake-${randomUUID()}`,
        roleKey: options.roleKey,
        cwd: options.cwd,
      }
      sessions.set(session.id, { session, onEvent: options.onEvent })
      return session
    },

    // `opts` (Task 7 : `extraMcpServers`/`extraAllowedTools`) n'a pas de sens
    // pour ce faux runtime — le comportement d'un appel d'outil se scripte
    // via `replies`, pas via un vrai câblage MCP. Paramètre accepté pour
    // rester compatible avec `RuntimeAdapter.send`, jamais lu.
    async send(session, message): Promise<AgentResult> {
      const entry = sessions.get(session.id)
      const reply = replies[cursor++] ?? `[fake] réponse à : ${message}`

      if (typeof reply === 'string') {
        const costTokens = message.length + reply.length
        entry?.onEvent({ type: 'text', text: reply })
        entry?.onEvent({ type: 'cost', tokens: costTokens })
        return { text: reply, costTokens, isError: false }
      }

      const costTokens = message.length + JSON.stringify(reply.toolUse.input).length
      entry?.onEvent({ type: 'tool_use', name: reply.toolUse.name, input: reply.toolUse.input })
      entry?.onEvent({ type: 'cost', tokens: costTokens })
      return { text: '', costTokens, isError: false, toolCalls: [reply.toolUse] }
    },

    async resume(sessionId) {
      return sessions.get(sessionId)?.session ?? null
    },

    async usage(): Promise<UsageSnapshot> {
      if (!opts.usage) return { fiveHourPct: 0, sevenDayPct: 0, available: false }
      return { ...opts.usage, available: true, sampledAt: new Date(0) }
    },
  }
}

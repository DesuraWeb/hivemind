import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { resolveToolPolicy } from './tools'
import type {
  AgentResult,
  AgentSession,
  CreateSessionOptions,
  RuntimeAdapter,
  UsageSnapshot,
} from './types'

/**
 * Notes de vérification (Task 10, Step 1) contre
 * `@anthropic-ai/claude-agent-sdk@0.3.227` — lu dans
 * `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (7457 lignes) avant
 * d'écrire ce fichier. Les marqueurs `⚠ vérifier` du plan sont tous confirmés
 * conformes — aucune divergence de nom de champ avec le squelette du plan :
 *
 * 1. `query({ prompt, options }): Query`, où `Query extends
 *    AsyncGenerator<SDKMessage, void>` — on peut faire `for await (const msg
 *    of stream)` directement, sans champ `.messages` ou `.stream`
 *    intermédiaire. Sur `Options` : `cwd?: string`, `systemPrompt?: string |
 *    string[] | { type: 'preset'; ... }` (une simple string passe),
 *    `model?: string`, `allowedTools?: string[]`, `permissionMode?:
 *    PermissionMode`, `resume?: string` existent tous tels quels. Les noms
 *    d'outils canoniques confirmés dans la doc de `tools`/`allowedTools`
 *    (ex. `['Bash', 'Read', 'Edit']`) et dans les commentaires internes du
 *    SDK : `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`. Une spec MCP au
 *    niveau serveur s'écrit `mcp__<serveur>` (documenté explicitement).
 *
 * 2. `session_id` est un champ top-level sur *tous* les variants de
 *    `SDKMessage` (`SDKAssistantMessage`, `SDKSystemMessage`,
 *    `SDKResultMessage`, etc.), pas niché sous `message`. Les blocs de
 *    contenu d'un message `assistant` sont `msg.message.content:
 *    BetaContentBlock[]` (type réexporté du SDK Messages standard) — un bloc
 *    texte est `{ type: 'text'; text: string }`, un appel d'outil est `{
 *    type: 'tool_use'; id; name; input }`. Sur le message final (`type ===
 *    'result'`, union `SDKResultSuccess | SDKResultError`) : `usage:
 *    NonNullableUsage` avec `input_tokens`/`output_tokens` non-nullables,
 *    `total_cost_usd: number`, `is_error: boolean` — tous typés directement,
 *    sans cast nécessaire une fois le type narrowed sur `msg.type ===
 *    'result'`.
 *
 * 3. Il n'existe **aucune fonction exportée** pour interroger la consommation
 *    par fenêtre en dehors d'une session active (`query`, `startup`,
 *    `listSessions`, etc. — aucune ne renvoie de pourcentage 5h/7j). Le SDK
 *    expose un type `SDKRateLimitEvent` (`type: 'rate_limit_event'`) avec
 *    `rate_limit_info: { status; rateLimitType: 'five_hour' | 'seven_day' |
 *    ...; utilization?: number; resetsAt?: number }`, mais ce n'est qu'un
 *    évènement poussé *pendant* une conversation en cours — il n'y a pas
 *    d'API de type `getUsage()` indépendante qu'on pourrait appeler à froid.
 *    Comme `RuntimeAdapter.usage()` doit pouvoir répondre sans session
 *    active, on ne peut pas s'appuyer dessus honnêtement pour l'instant :
 *    `usage()` retourne `{ fiveHourPct: 0, sevenDayPct: 0, available: false
 *    }`, conformément au plan. (Piste pour plus tard, hors scope Task 10 :
 *    capter opportunément `rate_limit_event` pendant les `send()` actifs et
 *    mémoriser le dernier percentage vu par fenêtre, plutôt que de l'exposer
 *    comme une vraie requête à la demande.)
 *
 * Task 2 : la traduction `ToolPolicy → options SDK` ne se fait plus à la main
 * ici. Elle vit dans `resolveToolPolicy` (`./tools.ts`, fonction pure,
 * testée en isolation) — voir ce fichier pour l'analyse complète de quelle(s)
 * option(s) SDK restreignent réellement la surface d'outils (`tools`,
 * `disallowedTools`) par opposition à celles qui ne font que dispenser du
 * prompt de permission (`allowedTools`). Constat d'origine (Phase 1, smoke
 * test) : avec `tools: { bash: false, ... }` côté politique mais seulement
 * `allowedTools` côté SDK, l'agent a quand même appelé `Bash` (`pwd`) avec
 * succès — `allowedTools` seul ne bloque rien.
 */

interface Live {
  session: AgentSession
  options: CreateSessionOptions
}

export function createClaudeAdapter(): RuntimeAdapter {
  const live = new Map<string, Live>()

  return {
    async healthcheck() {
      // Le seul signal fiable d'une auth valide est un échange réellement
      // abouti. On le garde minimal : pas d'outils, un mot en réponse. À la
      // cadence du cron (15 min) le coût est négligeable devant le risque
      // d'une panne d'authentification passée inaperçue.
      try {
        const { sdkOptions } = resolveToolPolicy({ bash: false, fs: 'none', mcp: [] })
        const stream = query({
          prompt: 'Réponds exactement : OK',
          options: { ...sdkOptions, maxTurns: 1 },
        })
        for await (const msg of stream) {
          if (msg.type === 'result') {
            return msg.is_error
              ? { ok: false, error: 'Le runtime a répondu en erreur.' }
              : { ok: true }
          }
        }
        return { ok: false, error: 'Le runtime n a produit aucun résultat.' }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async createSession(options) {
      const session: AgentSession = {
        id: `claude-${randomUUID()}`,
        roleKey: options.roleKey,
        cwd: options.cwd,
      }
      live.set(session.id, { session, options })
      return session
    },

    async send(session, message): Promise<AgentResult> {
      const entry = live.get(session.id)
      if (!entry) throw new Error(`Session inconnue : ${session.id}`)
      const { options } = entry

      let text = ''
      let costTokens = 0
      let isError = false

      const { sdkOptions } = resolveToolPolicy(options.tools)
      const stream = query({
        prompt: message,
        options: {
          cwd: options.cwd,
          systemPrompt: options.systemPrompt,
          ...(options.model ? { model: options.model } : {}),
          // Frontière de sécurité effective, voir `resolveToolPolicy` — pas
          // seulement `allowedTools` (constat en tête de fichier).
          ...sdkOptions,
          // Reprend la conversation quand le SDK nous a déjà donné un identifiant.
          ...(session.sdkSessionId ? { resume: session.sdkSessionId } : {}),
        },
      })

      for await (const msg of stream) {
        // Confirmé Step 1 (point 2) : `session_id` est top-level sur tous les
        // variants de SDKMessage.
        if (msg.session_id) {
          session.sdkSessionId = msg.session_id
        }

        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              text += block.text
              options.onEvent({ type: 'text', text: block.text })
            } else if (block.type === 'tool_use') {
              options.onEvent({ type: 'tool_use', name: block.name, input: block.input })
            }
          }
        }

        if (msg.type === 'result') {
          // Confirmé Step 1 (point 2) : `usage.input_tokens`/`output_tokens`
          // et `is_error` sont typés directement sur SDKResultMessage, pas de
          // cast nécessaire.
          costTokens = msg.usage.input_tokens + msg.usage.output_tokens
          isError = msg.is_error
          options.onEvent({ type: 'cost', tokens: costTokens })
        }
      }

      return { text, costTokens, isError }
    },

    async resume(sessionId) {
      return live.get(sessionId)?.session ?? null
    },

    async usage(): Promise<UsageSnapshot> {
      // Confirmé Step 1 (point 3) : le SDK n'expose aucune API de consultation
      // à froid des fenêtres 5h/7j (seulement un évènement poussé pendant une
      // session active). Tant que ce n'est pas le cas, on se déclare
      // indisponible plutôt que d'alimenter le scheduler de budget avec des
      // chiffres inventés.
      return { fiveHourPct: 0, sevenDayPct: 0, available: false }
    },
  }
}

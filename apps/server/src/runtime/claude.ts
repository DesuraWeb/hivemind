import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { resolveToolPolicy } from './tools'
import type {
  AgentResult,
  AgentSession,
  CreateSessionOptions,
  RuntimeAdapter,
  SendOptions,
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

/**
 * Dernière conso observée. Le SDK pousse `rate_limit_event` pendant une session
 * active ; il n'existe aucun moyen de l'interroger à froid, donc la mesure est
 * conservée en mémoire du process et datée.
 *
 * `rateLimitType` a six valeurs possibles, pas deux : `five_hour`, `seven_day`,
 * `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`,
 * `overage`. On replie toutes les variantes hebdomadaires sur `sevenDayPct` en
 * gardant le MAXIMUM : sous-estimer la conso ferait tourner le scheduler de
 * budget trop longtemps, la surestimer ne coûte qu'une pause prématurée.
 */
const lastUsage: { fiveHourPct: number; sevenDayPct: number; sampledAt?: Date } = {
  fiveHourPct: 0,
  sevenDayPct: 0,
}

function captureRateLimit(msg: unknown): void {
  const event = msg as { type?: string; rate_limit_info?: RateLimitInfo }
  if (event.type !== 'rate_limit_event' || !event.rate_limit_info) return

  const { rateLimitType, utilization } = event.rate_limit_info
  if (typeof utilization !== 'number' || !rateLimitType) return

  const pct = utilization <= 1 ? utilization * 100 : utilization
  if (rateLimitType === 'five_hour') {
    lastUsage.fiveHourPct = pct
  } else if (rateLimitType.startsWith('seven_day')) {
    lastUsage.sevenDayPct = Math.max(lastUsage.sevenDayPct, pct)
  } else {
    return // `overage` : hors des deux fenêtres suivies par le brief
  }
  lastUsage.sampledAt = new Date()
}

interface RateLimitInfo {
  rateLimitType?: string
  utilization?: number
}

export function createClaudeAdapter(): RuntimeAdapter {
  const live = new Map<string, Live>()

  return {
    async healthcheck() {
      // Le seul signal fiable d'une auth valide est un échange réellement
      // abouti. On le garde minimal : pas d'outils, un mot en réponse. À la
      // cadence du cron (15 min) le coût est négligeable devant le risque
      // d'une panne d'authentification passée inaperçue.
      const startedAt = Date.now()
      const elapsed = () => Date.now() - startedAt
      try {
        const { sdkOptions } = resolveToolPolicy({ bash: false, fs: 'none', mcp: [] })
        const stream = query({
          prompt: 'Réponds exactement : OK',
          options: { ...sdkOptions, maxTurns: 1 },
        })
        for await (const msg of stream) {
          captureRateLimit(msg)
          if (msg.type === 'result') {
            return msg.is_error
              ? { ok: false, latencyMs: elapsed(), error: 'Le runtime a répondu en erreur.' }
              : { ok: true, latencyMs: elapsed() }
          }
        }
        return {
          ok: false,
          latencyMs: elapsed(),
          error: 'Le runtime n a produit aucun résultat.',
        }
      } catch (err) {
        return {
          ok: false,
          latencyMs: elapsed(),
          error: err instanceof Error ? err.message : String(err),
        }
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

    async send(session, message, sendOpts?: SendOptions): Promise<AgentResult> {
      const entry = live.get(session.id)
      if (!entry) throw new Error(`Session inconnue : ${session.id}`)
      const { options } = entry

      let text = ''
      let costTokens = 0
      let isError = false
      const toolCalls: { name: string; input: unknown }[] = []

      const { sdkOptions } = resolveToolPolicy(options.tools)
      // Task 7 : un appelant (ex. `collectStructured`) peut câbler un outil
      // in-process pour ce seul échange, en plus de la ToolPolicy fixée à la
      // création de la session. On fusionne par-dessus `sdkOptions`, jamais
      // à sa place — `strictMcpConfig: true` reste posé (voir la note Task 2
      // en tête de `tools.ts`, et la note Task 7 en tête de `structured.ts`) :
      // seuls les serveurs explicitement listés ici (ceux du rôle + celui-ci)
      // sont visibles, pas ceux de l'hôte. Le cast est nécessaire :
      // `SendOptions.extraMcpServers` est volontairement opaque côté
      // `types.ts` pour ne pas coupler ce fichier partagé au SDK Claude.
      const mcpServers = {
        ...sdkOptions.mcpServers,
        ...(sendOpts?.extraMcpServers as Record<string, McpServerConfig> | undefined),
      }
      const allowedTools = [...sdkOptions.allowedTools, ...(sendOpts?.extraAllowedTools ?? [])]

      const stream = query({
        prompt: message,
        options: {
          cwd: options.cwd,
          systemPrompt: options.systemPrompt,
          ...(options.model ? { model: options.model } : {}),
          // Frontière de sécurité effective, voir `resolveToolPolicy` — pas
          // seulement `allowedTools` (constat en tête de fichier).
          ...sdkOptions,
          mcpServers,
          allowedTools,
          // Reprend la conversation quand le SDK nous a déjà donné un identifiant.
          ...(session.sdkSessionId ? { resume: session.sdkSessionId } : {}),
        },
      })

      for await (const msg of stream) {
        captureRateLimit(msg)
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
              // Task 7 : recopié dans le résultat retourné, pas seulement
              // poussé sur `onEvent` — `collectStructured` n'a pas accès à
              // l'`onEvent` de la session (fixé par l'appelant à la création),
              // c'est donc ce canal qu'il consulte pour savoir si l'agent a
              // appelé l'outil plutôt que répondu en texte libre.
              toolCalls.push({ name: block.name, input: block.input })
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

      return { text, costTokens, isError, toolCalls }
    },

    async resume(sessionId) {
      return live.get(sessionId)?.session ?? null
    },

    async usage(): Promise<UsageSnapshot> {
      // Le SDK n'expose aucune API de consultation à froid : la conso n'arrive
      // que poussée pendant une session active (voir captureRateLimit).
      // Tant qu'aucun échange n'a eu lieu, on se déclare indisponible plutôt
      // que d'alimenter le scheduler de budget avec des chiffres inventés.
      if (!lastUsage.sampledAt) return { fiveHourPct: 0, sevenDayPct: 0, available: false }
      return {
        fiveHourPct: lastUsage.fiveHourPct,
        sevenDayPct: lastUsage.sevenDayPct,
        available: true,
        sampledAt: lastUsage.sampledAt,
      }
    },
  }
}

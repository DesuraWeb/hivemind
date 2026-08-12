import type { RoleKey } from '@chapo/shared'

/** Ce qu'un rôle a le droit de faire. Traduit en options SDK par l'adapter. */
export interface ToolPolicy {
  /** Autorise l'exécution de commandes shell. */
  bash: boolean
  /** Accès système de fichiers dans le cwd de la session. */
  fs: 'none' | 'read' | 'write'
  /** Allowlist de serveurs/outils MCP exposés au rôle. */
  mcp: string[]
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'cost'; tokens: number }

export interface AgentSession {
  /** Identifiant local (le nôtre), stable pour toute la vie de la session. */
  id: string
  roleKey: RoleKey
  cwd: string
  /** Identifiant de session côté SDK, connu après le premier échange. */
  sdkSessionId?: string
}

export interface AgentResult {
  /** Texte final produit par l'agent. */
  text: string
  costTokens: number
  /** Vrai si la session s'est terminée en erreur côté SDK. */
  isError: boolean
}

export interface CreateSessionOptions {
  roleKey: RoleKey
  systemPrompt: string
  model?: string
  /** Worktree du run : tout accès fichier est relatif à ce répertoire. */
  cwd: string
  tools: ToolPolicy
  onEvent: (e: AgentEvent) => void
}

/**
 * Consommation du compte, par fenêtre. `available: false` signifie que le
 * runtime n'expose pas l'information — le scheduler de budget ne doit alors
 * jamais mettre un projet en pause.
 */
export interface UsageSnapshot {
  fiveHourPct: number
  sevenDayPct: number
  available: boolean
}

export interface HealthcheckResult {
  ok: boolean
  error?: string
}

export interface RuntimeAdapter {
  /**
   * Vérifie que le runtime est réellement joignable et authentifié.
   *
   * Méthode distincte de `createSession` à dessein : côté Claude, ouvrir une
   * session ne déclenche aucun appel réseau (le premier échange a lieu dans
   * `send`), donc s'appuyer dessus produirait un healthcheck qui répond
   * toujours « ok », y compris avec un token expiré. Détecter une auth cassée
   * suppose de parler au service — cet appel est volontairement minimal.
   */
  healthcheck(): Promise<HealthcheckResult>
  createSession(opts: CreateSessionOptions): Promise<AgentSession>
  send(session: AgentSession, message: string): Promise<AgentResult>
  resume(sessionId: string): Promise<AgentSession | null>
  usage(): Promise<UsageSnapshot>
}

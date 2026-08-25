import type { RoleKey } from '@silithid/shared'

/** Ce qu'un rôle a le droit de faire. Traduit en options SDK par l'adapter. */
export interface ToolPolicy {
  /** Autorise l'exécution de commandes shell. */
  bash: boolean
  /** Accès système de fichiers dans le cwd de la session. */
  fs: 'none' | 'read' | 'write'
  /** Allowlist de serveurs/outils MCP exposés au rôle. */
  mcp: string[]
  /**
   * Autorise la recherche web native du SDK.
   *
   * Absent = refusé. Un seul rôle l'obtient aujourd'hui : Hive sur l'écran de
   * création, pour vérifier qu'une stack est encore maintenue avant de la
   * proposer plutôt que de s'en remettre à sa date d'entraînement.
   *
   * Ce que ça coûte : un appel sortant, et **du contenu non fiable en
   * retour**. Un résultat de recherche qui contient des instructions n'est pas
   * une consigne — le brief de création le cadre explicitement. Les agents de
   * la boucle ne l'obtiennent pas au passage : un dev avec un accès web et un
   * accès disque en écriture est une surface qu'on n'ouvre pas pour rien.
   */
  web?: boolean
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
  /**
   * Appels d'outils observés pendant cet échange, dans l'ordre. Alimenté par
   * les deux adapters (Task 7) : `ClaudeAdapter` y recopie les blocs
   * `tool_use` réellement reçus, `FakeAdapter` y recopie les appels
   * scriptés — c'est le canal que `collectStructured` (`./structured.ts`)
   * consulte pour savoir si l'agent a appelé l'outil de sortie structurée
   * plutôt que de répondre en texte libre.
   */
  toolCalls?: { name: string; input: unknown }[]
}

/**
 * Additions ponctuelles à un seul échange, en plus de la `ToolPolicy` fixée
 * à la création de la session. Sert à câbler un outil in-process (Task 7 :
 * sortie structurée du garant) sans toucher à la politique persistée du
 * rôle : le champ est opaque ici pour garder ce fichier indépendant du SDK
 * Claude (comme le reste de `types.ts`) — c'est `claude.ts` qui connaît le
 * type réel (`McpServerConfig`) et fait le cast au point d'usage.
 *
 * Sécurité (suite de la Task 2) : ceci s'ajoute à `strictMcpConfig: true`,
 * posé systématiquement par `resolveToolPolicy` — jamais à sa place. Un
 * serveur passé ici est explicitement nommé par l'appelant ; l'hôte ne peut
 * toujours rien injecter par ailleurs.
 */
export interface SendOptions {
  /** Serveurs MCP in-process supplémentaires, valables pour ce seul appel. */
  extraMcpServers?: Record<string, unknown>
  /** Noms d'outils (natifs ou `mcp__serveur__outil`) à autoriser en plus, pour ce seul appel. */
  extraAllowedTools?: string[]
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
  /**
   * Date de la dernière mesure observée. `undefined` tant qu'aucun `send()`
   * n'a produit d'évènement de limite de débit.
   *
   * La règle de péremption (fraîche ≤ 90 min, sinon jauge « inconnu » et
   * majoration de 10 points) appartient au scheduler de budget : ici on se
   * contente de dater honnêtement la mesure.
   */
  sampledAt?: Date
  /**
   * Quand la fenêtre de 5 h se remet à zéro (`BUDGET.reset` du pack DA). Sans
   * elle, une jauge à 80 % ne dit pas s'il faut attendre dix minutes ou quatre
   * heures — deux décisions opposées pour le même chiffre.
   */
  resetsAt?: Date
}

export interface HealthcheckResult {
  ok: boolean
  /** Durée de l'échange de vérification. Sert à repérer une dégradation. */
  latencyMs: number
  /** Cause de l'échec — affichée dans l'item d'inbox et l'email d'alerte. */
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
  send(session: AgentSession, message: string, opts?: SendOptions): Promise<AgentResult>
  resume(sessionId: string): Promise<AgentSession | null>
  usage(): Promise<UsageSnapshot>
}

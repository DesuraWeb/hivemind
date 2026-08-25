import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { AgentSession, RuntimeAdapter, SendOptions } from './types'

/**
 * Notes de vérification (Task 7, Step 1) contre
 * `@anthropic-ai/claude-agent-sdk@0.3.227` — lu dans
 * `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (7457 lignes) avant
 * d'écrire ce fichier. Question posée : comment donne-t-on un outil custom,
 * in-process, à un agent ?
 *
 * - `export declare function createSdkMcpServer(_options:
 *   CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance` (~L482).
 *   Commentaire du SDK : « Creates an MCP server instance that can be used
 *   with the SDK transport. This allows SDK users to define custom tools
 *   that run in the same process. » `CreateSdkMcpServerOptions` (~L483) :
 *   `{ name: string; version?: string; instructions?: string; tools?:
 *   Array<SdkMcpToolDefinition<any>>; alwaysLoad?: boolean; timeout?:
 *   number }`. Le retour, `McpSdkServerConfigWithInstance` (~L1061), est
 *   `McpSdkServerConfig & { instance: McpServer }` — « Not serializable -
 *   contains a live McpServer object » : une vraie instance de process, pas
 *   une config sérialisable, cohérent avec « in-process ».
 *
 * - `export declare function tool<Schema extends AnyZodRawShape>(_name:
 *   string, _description: string, _inputSchema: Schema, _handler: (args:
 *   InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
 *   _extras?: {...}): SdkMcpToolDefinition<Schema>` (~L7248). `Schema`
 *   attend un `ZodRawShape` (le `.shape` d'un `z.object(...)`, pas le
 *   schema lui-même) — `AnyZodRawShape` (~L122) = `ZodRawShape |
 *   ZodRawShape_2` (zod 3 / zod 4). Le projet est en zod 3
 *   (`apps/server/package.json` : `"zod": "^3.24.1"`), le SDK aussi
 *   (`zod@3.25.76` en dépendance résolue) : compatible sans conversion.
 *   `CallToolResult` vient de `@modelcontextprotocol/sdk/types.js`
 *   (import de tête de fichier, ~L4) ; contextuel ici, pas importé
 *   explicitement (évite une dépendance directe à ce paquet transitif).
 *
 * - Câblage : `Options.mcpServers?: Record<string, McpServerConfig>`
 *   (~L1732), où `McpServerConfig` inclut `McpSdkServerConfigWithInstance`
 *   (~L1068). C'est le champ que `query({ options })` consomme.
 *
 * - Alternative écartée : `outputFormat?: { type: 'json_schema'; schema:
 *   Record<string, unknown> }` (~L1739-1750, `JsonSchemaOutputFormat`
 *   ~L930) existe et fait une sortie structurée native, avec retry et
 *   compteur internes (`error_max_structured_output_retries`,
 *   `structured_output_retry_exhausted` sur `TerminalReason` ~L7217,
 *   `structured_output?: unknown` sur le message `result` ~L4503). On ne
 *   la retient pas ici : le contrat du garant (plan, contrat 3) et le
 *   tech stack de la phase (« SDK MCP tool pour la sortie structurée »)
 *   demandent explicitement un OUTIL que l'agent APPELLE, avec un contrôle
 *   de retry qu'on écrit nous-mêmes (citer l'erreur zod dans le message de
 *   relance) — pas un mode de sortie qui contraint tout le tour de parole.
 *   `outputFormat` reste une piste pour un besoin futur de sortie
 *   contrainte sans notion d'« appel d'outil ».
 *
 * Conclusion : le SDK permet bien de définir un outil in-process
 * (`createSdkMcpServer` + `tool`) et de le rendre disponible pour un seul
 * échange via `mcpServers`. Ce n'est PAS `BLOCKED`.
 *
 * Sécurité (ne pas rouvrir le trou de la Task 2) : `resolveToolPolicy`
 * (`./tools.ts`) pose systématiquement `strictMcpConfig: true` avec
 * `mcpServers: {}` — sans ça, `mcp: []` n'empêche pas les connecteurs MCP de
 * l'hôte d'apparaître (constat du smoke test Task 2). Le serveur construit
 * ici n'est donc jamais ajouté à la `ToolPolicy` persistée du rôle : il est
 * transporté par `SendOptions.extraMcpServers` (`./types.ts`, ajouté par
 * cette tâche), fusionné PAR-DESSUS `sdkOptions.mcpServers` dans
 * `claude.ts`, pour ce seul appel à `send()` — `strictMcpConfig: true`
 * reste posé, donc seuls les serveurs explicitement listés (ceux du rôle +
 * celui-ci) sont visibles, jamais ceux de l'hôte. `FakeAdapter` ignore ce
 * champ : il scripte l'équivalent comportemental (« l'agent a appelé
 * l'outil ») directement dans `replies`, sans jamais construire de vrai
 * serveur MCP — c'est ce qui rend `collectStructured` testable sans SDK ni
 * tokens.
 */

/** Cadrage produit par le garant pour le développeur (plan, Task 7, Step 2). */
export const frameSchema = z.object({
  dev_prompt: z.string().min(50),
  acceptance_criteria: z.array(z.string().min(5)).min(1),
  pages_to_judge: z.array(z.string()),
})
export type Frame = z.infer<typeof frameSchema>

/**
 * Un candidat-savoir proposé par le garant au moment du verdict (Phase 7,
 * Task 3).
 *
 * ## Pourquoi ici, et pourquoi ça ne coûte rien
 *
 * La spec dit « le reviewer extrait les candidats ». Le reviewer ne voit que
 * le diff ; le garant a le cadrage, le rapport du reviewer, celui du juge et
 * son propre verdict — et il fait DÉJÀ un appel au modèle à cet instant. Les
 * candidats voyagent dans sa sortie structurée existante : zéro échange
 * supplémentaire, zéro token de plus par run.
 *
 * ## Ce que l'agent NE choisit PAS
 *
 * Il déclare une NATURE de cercle (`projet`/`client`/`globe`/`hive`), jamais
 * une instance. Aucun identifiant ne traverse ce schéma : le serveur résout
 * `cercle_id` depuis le projet du run lui-même (`knowledge/propose.ts`). Un
 * garant ne peut donc pas proposer un savoir dans le globe d'un autre — ce
 * n'est pas une règle à respecter, c'est une donnée qu'il n'a pas.
 */
export const candidatSavoirSchema = z.object({
  /**
   * Clé de détection de conflit (arbitrage du 15/08) : court, nominal,
   * réutilisable d'un run à l'autre. Borné à 80 : un « sujet » d'une phrase
   * ne recoupe jamais celui du run suivant, donc ne détecte aucun conflit.
   */
  sujet: z.string().min(3).max(80),
  contenu: z.string().min(20),
  cercle: z.enum(['projet', 'client', 'globe', 'hive']),
  stack: z.string().min(1).optional(),
  /**
   * Où ce savoir est vrai, quand il ne l'est pas partout : un hébergeur nommé
   * (`planethoster`) ou un type d'hébergement (`mutualise`, `vps`).
   *
   * Absent = vrai partout, et c'est le bon défaut. Déclaré à tort, un savoir
   * devient presque invisible ; omis à tort, il est rappelé à contretemps —
   * mais l'écran de revue permet de corriger l'un comme l'autre, et le second
   * cas se remarque, le premier non.
   */
  hebergement: z.string().min(1).max(60).optional(),
})
export type CandidatSavoir = z.infer<typeof candidatSavoirSchema>

/**
 * Verdict du garant après reviewer + juge visuel. Figé par le garant du
 * projet (plan, contrat 3) mais implémenté en Phase 4 : type seulement
 * ici, rien ne le construit ni ne le consomme dans cette tâche.
 *
 * `savoirs` (Phase 7, Task 3) est OPTIONNEL et borné à 3. Un run qui
 * n'apprend rien est le cas normal : rendre le champ obligatoire forcerait le
 * garant à inventer un savoir à chaque verdict, et ce bruit noierait le
 * signal. La borne joue le même rôle dans l'autre sens — trois propositions
 * par run suffisent largement, au-delà c'est du résumé de step déguisé.
 */
export const verdictSchema = z.object({
  decision: z.enum(['conforme', 'ecarts']),
  ecarts: z.array(
    z.object({
      severite: z.enum(['bloquant', 'majeur', 'mineur']),
      description: z.string(),
      correctif: z.string(),
    }),
  ),
  dev_prompt_correctif: z.string().optional(),
  savoirs: z.array(candidatSavoirSchema).max(3).optional(),
})
export type Verdict = z.infer<typeof verdictSchema>

/**
 * Rapport du juge visuel (Task 3, Phase 4), conforme au format déjà écrit
 * dans `src/db/seeds/role_templates/judge.md`. Volontairement SANS aucun
 * champ de décision (pas de `verdict`, pas de `recommandation`, pas de
 * `action`) : « le juge décrit, il ne décide pas » (judge.md) doit être vrai
 * ici, pas seulement dans le prompt — c'est le garant (`verdictSchema`
 * ci-dessus, Task 4) qui tranche depuis ce constat.
 *
 * `screenshot_ref` n'est PAS validé ici par zod (il n'existe aucune règle de
 * forme à vérifier — n'importe quelle chaîne non vide est syntaxiquement
 * valide) : la validation qui compte, « cette référence correspond-elle à un
 * artifact réellement enregistré ? », est une question de base de données, pas
 * de forme. Elle est faite côté serveur après réception, dans
 * `loop/steps/judging.ts` — voir le commentaire de tête de ce fichier pour la
 * décision sur une référence inventée.
 */
export const judgeReportSchema = z.object({
  conformites: z.array(z.string().min(1)),
  ecarts: z.array(
    z.object({
      severite: z.enum(['bloquant', 'majeur', 'mineur']),
      page: z.string().min(1),
      viewport: z.enum(['mobile', 'tablette', 'desktop']),
      description: z.string().min(1),
      screenshot_ref: z.string().min(1),
    }),
  ),
})
export type JudgeReport = z.infer<typeof judgeReportSchema>
export type JudgeEcart = JudgeReport['ecarts'][number]

export interface CollectStructuredOptions {
  /** Nom de l'outil que l'agent doit appeler (ex. `submit_frame`). */
  toolName: string
  /** Description de l'outil, transmise au modèle. */
  toolDescription: string
  /** Nombre maximal d'échanges avant d'abandonner. Défaut 3 (plan, Step 3). */
  maxAttempts?: number
  /**
   * Serveurs MCP à exposer EN PLUS de l'outil de sortie structurée, pour ce
   * seul échange — `client_kb` par exemple. Fusionnés, jamais substitués :
   * l'outil de sortie structurée reste disponible quoi qu'il arrive, sans quoi
   * l'agent n'aurait plus de moyen de rendre sa réponse.
   */
  extra?: SendOptions
}

/**
 * Envoie `prompt`, en exigeant que l'agent réponde en appelant l'outil
 * `opts.toolName` avec une charge validée par `schema` — jamais du texte
 * libre. Si l'agent répond en prose, ou si la charge ne valide pas, relance
 * avec un message qui rappelle le format ET cite l'erreur zod. Borné à
 * `opts.maxAttempts` (défaut 3) : au-delà, lève une erreur — c'est
 * l'appelant qui décide de la suite (ex. `awaiting_human`), pas cette
 * fonction.
 *
 * L'outil est construit une seule fois pour tout l'appel (pas de
 * reconstruction par tentative) : son handler ne fait rien d'autre
 * qu'accuser réception — la validation et l'extraction de la charge se
 * font ici, sur `AgentResult.toolCalls`, pas dans le handler.
 */
export async function collectStructured<Shape extends z.ZodRawShape>(
  adapter: RuntimeAdapter,
  session: AgentSession,
  prompt: string,
  schema: z.ZodObject<Shape>,
  opts: CollectStructuredOptions,
): Promise<z.infer<z.ZodObject<Shape>>> {
  const maxAttempts = opts.maxAttempts ?? 3
  const serverName = `silithid_${opts.toolName}`

  const structuredTool = tool(
    opts.toolName,
    opts.toolDescription,
    schema.shape,
    // Le handler n'a rien à décider : la validation zod et le mapping vers
    // la machine à états se font dans la boucle ci-dessous, sur la valeur
    // brute reçue via `AgentResult.toolCalls`. Le handler se contente
    // d'accuser réception pour clore l'appel d'outil côté modèle.
    async () => ({ content: [{ type: 'text' as const, text: 'Reçu.' }] }),
  )
  const server = createSdkMcpServer({ name: serverName, tools: [structuredTool] })
  const sendOpts: SendOptions = {
    extraMcpServers: { ...opts.extra?.extraMcpServers, [serverName]: server },
    extraAllowedTools: [
      ...(opts.extra?.extraAllowedTools ?? []),
      `mcp__${serverName}__${opts.toolName}`,
    ],
  }

  let currentPrompt = prompt
  let lastError = 'aucune tentative effectuée'

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await adapter.send(session, currentPrompt, sendOpts)

    const call = result.toolCalls?.find(
      (c) => c.name === opts.toolName || c.name.endsWith(`__${opts.toolName}`),
    )

    if (!call) {
      lastError = `Aucun appel à l'outil « ${opts.toolName} » détecté — réponse en texte libre reçue au lieu d'un appel d'outil.`
      currentPrompt = buildRetryPrompt(opts.toolName, lastError)
      continue
    }

    const parsed = schema.safeParse(call.input)
    if (parsed.success) return parsed.data

    lastError = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join(' ; ')
    currentPrompt = buildRetryPrompt(opts.toolName, lastError)
  }

  throw new Error(
    `Sortie structurée invalide après ${maxAttempts} tentatives ` +
      `(outil « ${opts.toolName} »). Dernière erreur : ${lastError}`,
  )
}

function buildRetryPrompt(toolName: string, zodError: string): string {
  return [
    `Ta réponse précédente n'a pas produit d'appel valide à l'outil « ${toolName} ».`,
    `Erreur : ${zodError}`,
    `Rappel du format attendu : appelle UNIQUEMENT l'outil « ${toolName} », jamais de texte libre.`,
  ].join('\n')
}

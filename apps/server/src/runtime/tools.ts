import type { ToolPolicy } from './types'

/**
 * Notes de vérification (Task 2, Step 1) contre
 * `@anthropic-ai/claude-agent-sdk@0.3.227` — lu dans
 * `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (7457 lignes) avant
 * d'écrire ce fichier. Ce qui suit établit quelle(s) option(s) de `Options`
 * (le second argument de `query({ prompt, options })`) restreignent
 * réellement la surface d'outils du modèle, par opposition à celles qui ne
 * font que dispenser du prompt de permission.
 *
 * - `allowedTools?: string[]` (sdk.d.ts ~L1392-1396) — le commentaire du SDK
 *   dit noir sur blanc : « List of tool names that are auto-allowed without
 *   prompting for permission. [...] To restrict which tools are available,
 *   use the `tools` option instead. » Ce n'est PAS une frontière de
 *   sécurité : un outil hors de `allowedTools` reste disponible, il déclenche
 *   juste un prompt de permission (que rien ne bloque en mode non
 *   interactif). C'est exactement le trou constaté en Phase 1 : `bash: false`
 *   traduit uniquement en absence de `Bash` dans `allowedTools` n'empêche pas
 *   l'appel, il l'autorise silencieusement dès que le SDK tourne sans
 *   validateur de permission interactif.
 *
 * - `tools?: string[] | { type: 'preset'; preset: 'claude_code' }`
 *   (sdk.d.ts ~L1447-1458) — « Specify the base set of available built-in
 *   tools. `[]` (empty array) - Disable all built-in tools. » C'est le
 *   véritable ensemble de base : un outil absent de `tools` n'existe pas
 *   dans le contexte du modèle, il ne peut pas être invoqué. C'est le champ
 *   qui restreint réellement la surface pour les outils natifs
 *   (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, ...).
 *
 * - `disallowedTools?: string[]` (sdk.d.ts ~L1415-1420, et redéfini de façon
 *   identique sur `AgentDefinition` ~L44-48) — « List of tool names that are
 *   disallowed. These tools will be removed from the model's context and
 *   cannot be used, even if they would otherwise be allowed. » Denylist
 *   réelle elle aussi (contrairement à `allowedTools`), et la seule à
 *   documenter explicitement la syntaxe MCP au niveau serveur
 *   (`mcp__server`, `mcp__server__*`, `mcp__*` retirent tous les outils du
 *   serveur nommé). On la renseigne en complément de `tools` : défense en
 *   profondeur si un outil natif venait à échapper à l'allowlist positive.
 *
 * - `permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' |
 *   'plan' | 'dontAsk' | 'auto'` (sdk.d.ts ~L2169) — gouverne uniquement la
 *   façon dont les prompts de permission sont résolus (jamais posés,
 *   toujours acceptés, etc.). N'a aucun effet sur quels outils *existent*
 *   pour le modèle : ce n'est pas une frontière de sécurité, c'est un
 *   réglage d'ergonomie orthogonal.
 *
 * - `canUseTool?: CanUseTool` (sdk.d.ts ~L206) — hook appelé avant chaque
 *   exécution d'outil, peut refuser. C'est un garde-fou *a posteriori* (le
 *   modèle voit toujours l'outil, la décision arrive après qu'il ait tenté
 *   de l'invoquer) ; on ne s'appuie pas dessus comme frontière principale,
 *   `tools`/`disallowedTools` retirent l'outil de la surface avant même que
 *   le modèle puisse essayer.
 *
 * Conclusion : la frontière effective est `tools` (allowlist positive des
 * outils natifs disponibles), doublée de `disallowedTools` en denylist de
 * sécurité. `allowedTools` reste utile — il évite les prompts de permission
 * pour les outils qu'on autorise déjà via `tools` — mais ne doit jamais être
 * le seul mécanisme invoqué pour une restriction.
 *
 * - `strictMcpConfig?: boolean` (sdk.d.ts ~L2030-2036) — « Only use MCP
 *   servers passed via the `mcpServers` option [...] ignoring all other MCP
 *   configurations: project `.mcp.json`, user settings, plugins [...] ».
 *   **Fait constaté au smoke test (Step 4)** : sans cette option, un agent
 *   avec `mcp: []` voyait quand même les connecteurs MCP de l'environnement
 *   hôte (ex. Gmail/Calendar/Drive d'un `~/.claude` local) — `tools` et
 *   `disallowedTools` ne couvrent que les outils natifs, ils ne coupent pas
 *   l'héritage de configuration MCP externe au processus. Sans
 *   `strictMcpConfig: true`, `mcp: []` n'est donc PAS une frontière réelle
 *   pour les outils MCP : c'est exactement le même type de trou que celui
 *   qui a motivé cette tâche, mais côté MCP plutôt que Bash. On le ferme en
 *   passant systématiquement `strictMcpConfig: true` avec `mcpServers: {}` :
 *   aucun serveur MCP n'est câblé par cette tâche (portée Task 2 — le
 *   câblage réel de `policy.mcp` vers des `mcpServers` par rôle est hors
 *   scope), donc la seule position honnête tant que ce câblage n'existe pas
 *   est « zéro outil MCP », jamais « tout ce que l'hôte a sous la main ».
 *
 * Les entrées MCP de `ToolPolicy.mcp` sont tout de même traduites en noms
 * `mcp__<serveur>` dans `allowed`/`sdkOptions.allowedTools`, par cohérence de
 * contrat et pour ne pas casser l'API le jour où des `mcpServers` réels
 * seront déclarés — mais tant que `mcpServers` reste vide, ces entrées ne
 * donnent accès à rien.
 */

/** Options SDK obtenues en traduisant une `ToolPolicy`. */
export interface ResolvedToolPolicy {
  /** Liste plate des outils effectivement autorisés (natifs + MCP préfixés). */
  allowed: string[]
  /** À fusionner tel quel dans `options` de `query()`. */
  sdkOptions: {
    /** Restreint réellement la surface d'outils natifs disponibles au modèle. */
    tools: string[]
    /** Dispense ces outils du prompt de permission (n'élargit jamais `tools`). */
    allowedTools: string[]
    /** Denylist explicite, défense en profondeur au-delà de l'allowlist `tools`. */
    disallowedTools: string[]
    /** Aucun serveur MCP câblé par cette tâche — voir la note en tête de fichier. */
    mcpServers: Record<string, never>
    /** Empêche l'héritage de MCP configurés hors process (voir la note en tête de fichier). */
    strictMcpConfig: true
  }
}

const ALL_BUILTIN_TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebSearch']

/** Outils natifs Claude Code (hors MCP) que la politique autorise. */
function builtinTools(policy: ToolPolicy): string[] {
  const tools: string[] = []
  if (policy.bash) tools.push('Bash')
  if (policy.fs !== 'none') tools.push('Read', 'Glob', 'Grep')
  if (policy.fs === 'write') tools.push('Write', 'Edit')
  // `WebSearch` est natif au SDK : pas une dépendance, une ligne de politique.
  // `WebFetch` n'est PAS ouvert — chercher rend des extraits indexés, aller
  // chercher une page rend ce que cette page veut bien servir à un agent, ce
  // qui est une surface d'injection nettement plus large pour un gain nul ici.
  if (policy.web) tools.push('WebSearch')
  return tools
}

/**
 * Traduit une `ToolPolicy` en options SDK. Fonction pure : aucune dépendance
 * au SDK ni au runtime, seulement des chaînes en entrée et en sortie —
 * testable sans jamais toucher le réseau.
 */
export function resolveToolPolicy(policy: ToolPolicy): ResolvedToolPolicy {
  const builtin = builtinTools(policy)
  const mcp = policy.mcp.map((name) => `mcp__${name}`)
  const allowed = [...builtin, ...mcp]

  return {
    allowed,
    sdkOptions: {
      // Frontière effective : tout outil natif absent d'ici n'existe pas
      // pour le modèle (voir la note en tête de fichier).
      tools: builtin,
      allowedTools: allowed,
      disallowedTools: ALL_BUILTIN_TOOLS.filter((t) => !builtin.includes(t)),
      // Coupe l'héritage de config MCP externe (constat du smoke test,
      // Step 4) : sans ça, `mcp: []` n'empêche pas les connecteurs MCP de
      // l'hôte d'apparaître dans la surface du modèle.
      mcpServers: {},
      strictMcpConfig: true,
    },
  }
}

import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { loopFromRunState } from '../projects/derive'
import type { RuntimeAdapter, ToolPolicy } from '../runtime/types'

/**
 * Le fil de conversation avec Hive (le rôle `majordome`).
 *
 * ## Ce que ça débouche
 *
 * Le champ pilule du bandeau `HiveStrip` existe depuis la Phase 3 : on peut y
 * écrire, et il ne se passe rien. C'était un `useState` local sans destinataire.
 * Le rôle `majordome` existe lui aussi depuis la Phase 1, avec son prompt
 * (`db/seeds/role_templates/majordome.md`) et sa politique d'outils — mais
 * rien ne l'avait jamais appelé. Les deux moitiés étaient là, sans le fil
 * entre elles.
 *
 * ## Où vivent les messages
 *
 * Dans `messages`, avec `run_id = null`. La colonne est nullable au schéma
 * depuis le début, et c'est le bon endroit : c'est la piste d'audit du projet,
 * une conversation avec Hive en fait partie. Un `run_id` nul les exclut
 * naturellement de `readRunMessages` (qui filtre par run) et du journal
 * (`listNight` fait une jointure interne sur `runs`) — donc aucune pollution
 * de la timeline d'un run ni de la nuit des agents.
 *
 * ## Le coût
 *
 * C'est le premier endroit où Florian dépense des tokens en tapant, sans
 * qu'une boucle ne soit en cause. Deux conséquences assumées : le contexte
 * envoyé est **borné** (les derniers échanges, pas tout l'historique), et
 * l'état du parc est **résumé**, jamais dumpé — envoyer cent projets en entier
 * à chaque question coûterait plus cher que la réponse ne vaut.
 */

/** Nombre d'échanges rappelés à Hive. Au-delà, le contexte coûte plus qu'il n'aide. */
const HISTORY_LIMIT = 20

/** Interlocuteur humain dans le bus. Pas un `RoleKey` : ce n'est pas un agent. */
export const HUMAN_ROLE = 'florian'

export interface HiveMessage {
  id: string
  from: string
  body: string
  at: string
}

export interface AskHiveResult {
  reply: HiveMessage
  costTokens: number
}

async function readHistory(db: Kysely<Database>, limit: number): Promise<HiveMessage[]> {
  const rows = await db
    .selectFrom('messages')
    .select(['id', 'from_role as fromRole', 'body', 'created_at as createdAt'])
    .where('run_id', 'is', null)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute()

  // Lu du plus récent (pour la limite), rendu du plus ancien (pour la lecture).
  return rows.reverse().map((r) => ({
    id: String(r.id),
    from: r.fromRole,
    body: r.body,
    at: new Date(r.createdAt as unknown as string).toISOString(),
  }))
}

export function listHiveMessages(db: Kysely<Database>, limit = 50): Promise<HiveMessage[]> {
  return readHistory(db, limit)
}

/**
 * L'état du parc, résumé en quelques lignes.
 *
 * Volontairement du texte et non du JSON : c'est ce que lit un modèle, et une
 * phrase coûte moins de tokens qu'un objet équivalent. Volontairement un
 * RÉSUMÉ et non un dump : Hive doit savoir où regarder, il n'a pas besoin de
 * tout savoir pour répondre « où en est le Koin ».
 */
async function buildContext(db: Kysely<Database>): Promise<string> {
  const projects = await db
    .selectFrom('projects')
    .leftJoin('steps', 'steps.project_id', 'projects.id')
    .leftJoin('runs', 'runs.step_id', 'steps.id')
    .select(['projects.slug as slug', 'projects.name as name', 'runs.state as state'])
    .orderBy('projects.created_at', 'asc')
    .execute()

  const byProject = new Map<string, { name: string; states: string[] }>()
  for (const row of projects) {
    const entry = byProject.get(row.slug) ?? { name: row.name, states: [] }
    if (row.state) entry.states.push(row.state)
    byProject.set(row.slug, entry)
  }

  const lines = [...byProject.entries()].map(([slug, p]) => {
    const last = p.states.at(-1) ?? null
    return `- ${p.name} (${slug}) · ${loopFromRunState(last as never)}`
  })

  const inbox = await db
    .selectFrom('inbox_items')
    .select(['type'])
    .where('status', '=', 'open')
    .execute()
  const counts = new Map<string, number>()
  for (const item of inbox) counts.set(item.type, (counts.get(item.type) ?? 0) + 1)
  const inboxLine =
    counts.size === 0
      ? 'aucune décision en attente'
      : [...counts.entries()].map(([type, n]) => `${n} ${type}`).join(' · ')

  return [
    "## État du parc (résumé, pas exhaustif — demande si tu as besoin d'un détail)",
    lines.length > 0 ? lines.join('\n') : '- aucun projet',
    '',
    `## Inbox : ${inboxLine}`,
  ].join('\n')
}

/**
 * Lit le template `majordome` directement, sans passer par
 * `resolveProjectRole` : celui-ci matérialise un rôle POUR UN PROJET dans la
 * table `roles`, et Hive est transverse — il n'appartient à aucun projet. Lui
 * fabriquer une instance par projet créerait autant de copies du même rôle
 * qu'il y a de projets, chacune dérivant de son côté.
 *
 * La version la plus haute s'applique, comme partout ailleurs.
 */
async function readMajordomeTemplate(
  db: Kysely<Database>,
): Promise<{ systemPrompt: string; tools: ToolPolicy }> {
  const row = await db
    .selectFrom('role_templates')
    .select(['system_prompt as systemPrompt', 'tools'])
    .where('key', '=', 'majordome')
    .orderBy('version', 'desc')
    .executeTakeFirst()

  if (!row) {
    throw new Error("aucun template de rôle « majordome » en base : le seed n'a pas été appliqué")
  }
  return { systemPrompt: row.systemPrompt, tools: row.tools as unknown as ToolPolicy }
}

export interface AskHiveDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  /** Répertoire de travail de la session. Hive n'a aucun accès fichier, mais le SDK en exige un. */
  cwd: string
}

/**
 * Un tour de conversation. Le message humain est écrit AVANT l'appel au
 * modèle : si le modèle échoue, ce que Florian a tapé n'est pas perdu.
 */
export async function askHive(deps: AskHiveDeps, text: string): Promise<AskHiveResult> {
  const { db, adapter } = deps

  await db
    .insertInto('messages')
    .values({
      run_id: null,
      from_role: HUMAN_ROLE,
      to_role: 'majordome',
      kind: 'question',
      body: text,
      meta: JSON.stringify({}),
    })
    .execute()

  const history = await readHistory(db, HISTORY_LIMIT)
  const context = await buildContext(db)

  const role = await readMajordomeTemplate(db)

  const session = await adapter.createSession({
    roleKey: 'majordome',
    systemPrompt: role.systemPrompt,
    cwd: deps.cwd,
    tools: role.tools,
    onEvent: () => {},
  })

  const conversation = history
    .slice(0, -1)
    .map((m) => `${m.from === HUMAN_ROLE ? 'Florian' : 'Toi'} : ${m.body}`)
    .join('\n')

  const result = await adapter.send(
    session,
    [
      context,
      conversation ? `\n## Échanges précédents\n${conversation}` : '',
      `\n## Florian vient d'écrire\n${text}`,
    ].join('\n'),
  )

  await db
    .insertInto('messages')
    .values({
      run_id: null,
      from_role: 'majordome',
      to_role: HUMAN_ROLE,
      kind: 'info',
      body: result.text,
      meta: JSON.stringify({ cost_tokens: result.costTokens }),
    })
    .execute()

  const [reply] = (await readHistory(db, 1)).slice(-1)
  return {
    reply: reply ?? { id: '0', from: 'majordome', body: result.text, at: new Date().toISOString() },
    costTokens: result.costTokens,
  }
}

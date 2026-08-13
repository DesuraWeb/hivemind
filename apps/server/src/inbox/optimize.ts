import { tmpdir } from 'node:os'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { DEFAULT_ANSWER_BASELINE, DEFAULT_STACK_RULES } from '../db/seed'
import type { Database } from '../db/types'
import { resolveProjectRole } from '../loop/roles'
import { type ClientRow, clientSummary } from '../loop/steps/framing'
import { collectStructured } from '../runtime/structured'
import type { RuntimeAdapter, ToolPolicy } from '../runtime/types'
import type { SettingsStore } from '../settings/store'

/**
 * Sortie structurée de « la réponse optimisée par Hive » (BRIEF-RETOUR.md
 * §6 : « la formulation de Florian fait foi »). `optimized` est une
 * PROPOSITION, jamais écrite en base par cette route — seul un humain qui
 * clique « Utiliser » (QuestionPanel) puis résout l'item la fait passer côté
 * réel. `added` liste ce que Hive a injecté que Florian n'avait pas dit :
 * c'est ce qui rend la proposition auditable au lieu d'être une réécriture
 * opaque, et le signal attendu par la future boucle d'apprentissage (phase
 * conscience, non implémentée ici).
 */
export const optimizeAnswerSchema = z.object({
  optimized: z.string().min(1),
  added: z.array(z.string()),
})
export type OptimizeAnswerResult = z.infer<typeof optimizeAnswerSchema>

/**
 * Secours si `settings['hive.answer_baseline']` n'a jamais été écrit (base
 * migrée sans passer par `seedDefaultSettings`) : la même valeur que le seed,
 * pour ne jamais planter la route pour une raison qui n'a rien à voir avec la
 * question posée. Le réglage réel reste éditable dans les réglages.
 */
async function loadBaseline(settings: SettingsStore): Promise<string> {
  const value = await settings.get<string>('hive.answer_baseline')
  return typeof value === 'string' && value.trim().length > 0 ? value : DEFAULT_ANSWER_BASELINE
}

/**
 * Règles de la stack du projet, s'il y en a. Comparaison en minuscules et par
 * inclusion : « Laravel 12 » déclenche la règle `laravel`.
 *
 * Injectées séparément du socle commun : mêler les règles PrestaShop à une
 * question sur un projet WordPress ferait payer des tokens pour des contraintes
 * hors sujet, et diluerait celles qui comptent.
 */
async function loadStackRules(
  settings: SettingsStore,
  stack: string | null,
): Promise<string | null> {
  if (!stack) return null
  const stored = await settings.get<Record<string, string>>('hive.stack_rules')
  const rules = stored && typeof stored === 'object' ? stored : DEFAULT_STACK_RULES
  const haystack = stack.toLowerCase()
  for (const [key, value] of Object.entries(rules)) {
    if (haystack.includes(key)) return value
  }
  return null
}

export interface OptimizeAnswerInput {
  projectId: string
  /** La question posée à l'humain (item.title, cf. QuestionPanel : « le titre de l'item EST la question »). */
  question: string
  /** La réponse brute de Florian, telle que tapée dans le champ — jamais réécrite silencieusement. */
  draft: string
}

function buildPrompt(opts: {
  projectName: string
  projectContext: string | null
  client: string
  question: string
  draft: string
  baseline: string
  stackRules: string | null
}): string {
  return [
    '# Contexte projet',
    `Projet : ${opts.projectName}`,
    opts.projectContext ?? '(aucun contexte projet renseigné)',
    '',
    '# Fiche client',
    opts.client,
    '',
    '# Paramètres de base sous-entendus par Florian',
    '(point de départ à affiner, réglage `hive.answer_baseline` — ne les cite que si pertinents pour cette question)',
    opts.baseline,
    '',
    ...(opts.stackRules ? ['# Règles propres à la stack de ce projet', opts.stackRules, ''] : []),
    '# Question posée à Florian',
    opts.question,
    '',
    '# Réponse brute de Florian',
    opts.draft,
    '',
    'Florian répond souvent de façon lapidaire ("Ok réalise ce design", "corrige ces bugs") : ',
    "l'agent qui va exécuter a besoin de savoir quoi exactement, sous quelles contraintes.",
    "Rédige une version enrichie de cette réponse, à destination de l'agent, qui :",
    '- garde le sens et la décision de Florian intacts, ne les contredit jamais ;',
    '- explicite les paramètres de base ci-dessus quand ils s’appliquent à cette réponse ;',
    "- reste concise : une note d'exécution, pas un roman.",
    "Rends ta proposition en appelant l'outil de sortie structurée : `optimized` (le texte complet à proposer), ",
    "`added` (la liste, en français, de ce que tu as ajouté et que Florian n'avait pas dit — vide si tu n'as rien ajouté).",
  ].join('\n')
}

/**
 * Construit la proposition de réponse optimisée pour un item de type
 * `question`. Ne lit et n'écrit aucun état de l'item — l'appelant (route
 * `POST /api/inbox/:id/optimize`) fournit tout ce qui vient de l'item, cette
 * fonction ne fait que le contexte projet/client et l'appel modèle.
 */
export async function optimizeAnswer(
  db: Kysely<Database>,
  adapter: RuntimeAdapter,
  settings: SettingsStore,
  input: OptimizeAnswerInput,
): Promise<OptimizeAnswerResult> {
  const project = await db
    .selectFrom('projects')
    .select(['id', 'name', 'context', 'client_id', 'stack'])
    .where('id', '=', input.projectId)
    .executeTakeFirstOrThrow()

  const client: ClientRow | undefined = project.client_id
    ? await db
        .selectFrom('clients')
        .select(['name', 'tone', 'notes'])
        .where('id', '=', project.client_id)
        .executeTakeFirst()
    : undefined

  const role = await resolveProjectRole(db, project.id, 'majordome')
  const baseline = await loadBaseline(settings)
  const stackRules = await loadStackRules(settings, project.stack)

  const session = await adapter.createSession({
    roleKey: 'majordome',
    systemPrompt: role.systemPrompt,
    // Le majordome n'a pas d'accès fichier (`tools.fs === 'none'`, db/seed.ts) :
    // ce cwd n'est jamais consulté par l'agent, `tmpdir()` évite juste
    // d'exposer le répertoire réel du process serveur pour rien.
    cwd: tmpdir(),
    tools: role.tools as unknown as ToolPolicy,
    onEvent: () => {},
  })

  const prompt = buildPrompt({
    projectName: project.name,
    projectContext: project.context,
    client: clientSummary(client),
    question: input.question,
    draft: input.draft,
    baseline,
    stackRules,
  })

  return collectStructured(adapter, session, prompt, optimizeAnswerSchema, {
    toolName: 'submit_optimized_answer',
    toolDescription:
      "Rend la réponse optimisée à proposer à l'agent (optimized) et la liste de ce qui a été ajouté par rapport à la réponse brute de Florian (added).",
  })
}

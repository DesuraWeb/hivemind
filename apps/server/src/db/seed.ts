import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLE_KEYS, type RoleKey } from '@silithid/shared'
import type { Kysely } from 'kysely'
import { BUDGET_SETTINGS_KEYS, DEFAULT_BUDGET_THRESHOLDS } from '../budget/scheduler'
import { DEFAULT_GUARDED_PATHS, GUARDED_PATHS_SETTINGS_KEY } from '../security/guarded-paths'
import type { Database } from './types'

const SEEDS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'seeds', 'role_templates')

/** Politique d'outils par rôle. Consommée par le RuntimeAdapter (ToolPolicy). */
const TOOLS: Record<RoleKey, unknown> = {
  majordome: { bash: false, fs: 'none', mcp: ['db_read', 'create_project_draft'] },
  garant: { bash: false, fs: 'read', mcp: ['websearch', 'webfetch', 'client_kb', 'bus'] },
  dev: { bash: true, fs: 'write', mcp: ['git', 'gh', 'client_kb', 'bus'] },
  reviewer: { bash: true, fs: 'read', mcp: ['git', 'gh', 'bus'] },
  judge: { bash: false, fs: 'read', mcp: ['bus'] },
  communicant: { bash: false, fs: 'none', mcp: ['gmail_draft', 'client_kb', 'bus'] },
}

/**
 * Insère les templates de rôle `generic` v1. Idempotent : ré-exécuter met à jour
 * le prompt et les outils sans créer de doublon (clé unique key/project_type/version).
 */
export async function seedRoleTemplates(db: Kysely<Database>): Promise<void> {
  for (const key of ROLE_KEYS) {
    const systemPrompt = await readFile(join(SEEDS_DIR, `${key}.md`), 'utf8')
    await db
      .insertInto('role_templates')
      .values({
        key,
        project_type: 'generic',
        version: 1,
        system_prompt: systemPrompt,
        tools: JSON.stringify(TOOLS[key]),
        model: null,
      })
      .onConflict((oc) =>
        oc.columns(['key', 'project_type', 'version']).doUpdateSet({
          system_prompt: systemPrompt,
          tools: JSON.stringify(TOOLS[key]),
        }),
      )
      .execute()
  }
}

/**
 * Paramètres de base sous-entendus par Florian dans ses réponses lapidaires
 * (« Ok réalise ce design », « corrige ces bugs ») — injectés par
 * `POST /api/inbox/:id/optimize` (inbox/optimize.ts) dans la proposition de
 * Hive, jamais dans la réponse brute elle-même. Point de départ à affiner au
 * fil de l'usage, pas une vérité figée : modifiable dans les réglages sans
 * redéploiement. La boucle qui apprendrait ces paramètres depuis les
 * corrections de Florian (BRIEF-RETOUR.md §6, « conscience collective ») est
 * hors scope ici — ce réglage reste statique tant qu'elle n'existe pas.
 */
export const DEFAULT_ANSWER_BASELINE =
  "[socle de règles retiré de l’historique · voir seeds/prive/]"

/**
 * Règles propres à une stack, injectées UNIQUEMENT quand `projects.stack`
 * correspond. Les mettre dans le socle commun ferait traîner les règles
 * PrestaShop sur un projet WordPress : du bruit, et des tokens dépensés pour
 * des contraintes hors sujet.
 *
 * Les clés sont comparées en minuscules, sans accent, par inclusion : un
 * `projects.stack` valant « Laravel 12 » déclenche la règle `laravel`.
 *
 * Deux règles portent la mention RÈGLE MANQUANTE : Florian les a laissées en
 * suspens. Elles restent visibles exprès, pour que Hive dise qu'il ne sait pas
 * plutôt que d'inventer une contrainte.
 */
export const DEFAULT_STACK_RULES: Record<string, string> = {}

/**
 * Taux de conversion tokens → euros, affiché dans les listes de projets
 * (« 14,2 k tokens · 2,10 € »). Valeur d'ordre de grandeur, pas de
 * facturation : elle est destinée à donner une échelle, pas un montant exact.
 * Modifiable dans les réglages sans redéploiement.
 */
export async function seedDefaultSettings(db: Kysely<Database>): Promise<void> {
  await db
    .insertInto('settings')
    .values({ key: 'pricing.eur_per_mtok', value: JSON.stringify(15) })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute()

  await db
    .insertInto('settings')
    .values({ key: 'hive.answer_baseline', value: JSON.stringify(DEFAULT_ANSWER_BASELINE) })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute()

  await db
    .insertInto('settings')
    .values({ key: 'hive.stack_rules', value: JSON.stringify(DEFAULT_STACK_RULES) })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute()

  // Le 4ᵉ gate (Task 6, Phase 4) : liste éditable sans redéploiement — voir
  // security/guarded-paths.ts pour ce qu'elle contient et pourquoi.
  await db
    .insertInto('settings')
    .values({
      key: GUARDED_PATHS_SETTINGS_KEY,
      value: JSON.stringify(DEFAULT_GUARDED_PATHS),
    })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute()

  // Seuils du scheduler de budget (Phase 5, Task 2). Les défauts et leur
  // justification vivent dans `budget/scheduler.ts` : ici on ne fait que les
  // matérialiser en base pour qu'ils soient modifiables sans redéploiement.
  // `doNothing` sur conflit : un seuil ajusté par Florian ne doit pas être
  // réécrit par un `pnpm db:seed`.
  for (const [key, value] of [
    [BUDGET_SETTINGS_KEYS.reservePct, DEFAULT_BUDGET_THRESHOLDS.reservePct],
    [BUDGET_SETTINGS_KEYS.resumePct, DEFAULT_BUDGET_THRESHOLDS.resumePct],
    [BUDGET_SETTINGS_KEYS.stalenessMinutes, DEFAULT_BUDGET_THRESHOLDS.stalenessMinutes],
    [BUDGET_SETTINGS_KEYS.staleBumpPct, DEFAULT_BUDGET_THRESHOLDS.staleBumpPct],
  ] as const) {
    await db
      .insertInto('settings')
      .values({ key, value: JSON.stringify(value) })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute()
  }
}

// Point d'entrée CLI : `pnpm db:seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb, closeDb } = await import('./client')
  await seedRoleTemplates(getDb())
  await seedDefaultSettings(getDb())
  console.log(`${ROLE_KEYS.length} templates de rôle seedés.`)
  await closeDb()
}

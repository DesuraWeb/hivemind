import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLE_KEYS, type RoleKey } from '@silithid/shared'
import type { Kysely } from 'kysely'
import { BUDGET_SETTINGS_KEYS, DEFAULT_BUDGET_THRESHOLDS } from '../budget/scheduler'
import { RECETTES_GENERIQUES, STACK_RECIPES_SETTINGS_KEY } from '../ops/recipes'
import { DEFAULT_GUARDED_PATHS, GUARDED_PATHS_SETTINGS_KEY } from '../security/guarded-paths'
import { DEFAULT_ANSWER_BASELINE, DEFAULT_STACK_RULES } from './seeds/baseline'
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
  /**
   * Le rôle qui parle aux serveurs, et celui dont la politique compte le plus.
   *
   * `bash: false` et `fs: 'none'` : aucun accès à la machine qui l'héberge. La
   * seule surface est `ops_read`, qui n'expose qu'une LECTURE de fichier de
   * configuration sur le serveur distant. Il n'existe aucun outil d'écriture,
   * aucun outil d'exécution, sur aucune des deux machines.
   *
   * Ce qu'il produit est un PLAN, en sortie structurée. C'est du code serveur
   * qui le valide contre le catalogue borné (`ops/operations.ts`) et le
   * traduit en commandes. L'impossibilité d'exécuter n'est donc pas une
   * consigne de prompt : il n'y a rien à appeler.
   */
  ops: { bash: false, fs: 'none', mcp: ['ops_read', 'client_kb', 'bus'] },
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

  // Les recettes de déploiement par stack (Phase 6, Task 7). `doNothing` sur
  // conflit, comme les autres : une recette enrichie par l'expérience ne doit
  // pas être réécrite par un `pnpm db:seed`. C'est tout l'intérêt — le premier
  // déploiement d'une stack et le quinzième ne doivent pas être le même.
  await db
    .insertInto('settings')
    .values({ key: STACK_RECIPES_SETTINGS_KEY, value: JSON.stringify(RECETTES_GENERIQUES) })
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

/**
 * Réexporté pour les appelants historiques (`inbox/optimize.ts`). Le socle
 * lui-même vit dans `seeds/baseline.ts`, avec son recouvrement privé.
 */
export { DEFAULT_ANSWER_BASELINE, DEFAULT_STACK_RULES }

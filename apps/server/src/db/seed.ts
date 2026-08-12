import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLE_KEYS, type RoleKey } from '@chapo/shared'
import type { Kysely } from 'kysely'
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

// Point d'entrée CLI : `pnpm db:seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb, closeDb } = await import('./client')
  await seedRoleTemplates(getDb())
  console.log(`${ROLE_KEYS.length} templates de rôle seedés.`)
  await closeDb()
}

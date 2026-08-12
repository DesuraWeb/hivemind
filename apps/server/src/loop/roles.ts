import type { RoleKey } from '@chapo/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'

export interface ResolvedRole {
  key: RoleKey
  systemPrompt: string
  tools: Record<string, unknown>
  model: string | null
}

/**
 * Résout le rôle `key` d'un projet.
 *
 * `roles` fait autorité dès qu'une ligne existe pour ce couple
 * (projet, rôle) : c'est la copie éditable du projet (l'utilisateur a pu
 * modifier le prompt ou les outils depuis le template). Sinon, elle est
 * matérialisée depuis `role_templates` (`project_type` "generic", version la
 * plus récente — aucun projet typé n'existe encore) et persistée dans
 * `roles` pour que les résolutions suivantes n'aient plus à retoucher au
 * template.
 */
export async function resolveProjectRole(
  db: Kysely<Database>,
  projectId: string,
  key: RoleKey,
): Promise<ResolvedRole> {
  const existing = await db
    .selectFrom('roles')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('key', '=', key)
    .executeTakeFirst()

  if (existing) {
    return {
      key: existing.key as RoleKey,
      systemPrompt: existing.system_prompt,
      tools: existing.tools as Record<string, unknown>,
      model: existing.model,
    }
  }

  const template = await db
    .selectFrom('role_templates')
    .selectAll()
    .where('key', '=', key)
    .where('project_type', '=', 'generic')
    .orderBy('version', 'desc')
    .executeTakeFirst()

  if (!template) {
    throw new Error(`aucun role_template "${key}" (project_type "generic") — seed-le manquant ?`)
  }

  // `onConflict().doNothing()` : deux résolutions concurrentes du même rôle
  // (deux jobs pour le même run, par exemple) ne doivent pas se battre sur la
  // contrainte unique (project_id, key). Celle qui perd la course relit ce
  // que l'autre a inséré plutôt que d'échouer.
  const inserted = await db
    .insertInto('roles')
    .values({
      project_id: projectId,
      template_id: template.id,
      key: template.key,
      system_prompt: template.system_prompt,
      tools: JSON.stringify(template.tools),
      model: template.model,
    })
    .onConflict((oc) => oc.columns(['project_id', 'key']).doNothing())
    .returningAll()
    .executeTakeFirst()

  const row =
    inserted ??
    (await db
      .selectFrom('roles')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('key', '=', key)
      .executeTakeFirstOrThrow())

  return {
    key: row.key as RoleKey,
    systemPrompt: row.system_prompt,
    tools: row.tools as Record<string, unknown>,
    model: row.model,
  }
}

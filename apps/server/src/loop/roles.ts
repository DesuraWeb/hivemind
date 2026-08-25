import type { RoleKey } from '@silithid/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'

export interface ResolvedRole {
  key: RoleKey
  systemPrompt: string
  tools: Record<string, unknown>
  model: string | null
  /**
   * Ce rôle travaille-t-il sur ce projet ?
   *
   * La colonne existe au schéma depuis l'origine et n'était lue par personne :
   * décocher un agent ne faisait rien. Elle devient effective là où sauter un
   * agent a un sens — le reviewer et le communicant — en court-circuitant le
   * handler, jamais en touchant `decide()`. Même motif que `juge_visuel`
   * (`deploying.ts`) : l'état est traversé et la timeline dit pourquoi, plutôt
   * que d'être sauté par une machine à états qu'on aurait rendue conditionnelle.
   *
   * `dev` et `garant` ne sont pas désactivables : une boucle sans eux n'a pas
   * de sens. Le juge a déjà son interrupteur par projet (`projects.juge_visuel`)
   * et ne prend pas celui-ci — deux drapeaux pour une même chose, c'est un
   * jour où les deux se contredisent.
   */
  enabled: boolean
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
      enabled: existing.enabled,
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
    enabled: row.enabled,
  }
}

import type { RoleKey } from '@silithid/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'

/**
 * L'équipe d'un projet (onglet « Équipe » de `Projet.dc.html`).
 *
 * ## Un rôle n'existe pas tant qu'il n'a pas servi
 *
 * `resolveProjectRole` (`loop/roles.ts`) matérialise un rôle dans la table
 * `roles` **paresseusement**, à sa première résolution — donc au premier run
 * qui en a besoin. Un projet créé mais jamais lancé n'a aucune ligne dans
 * `roles`, et ce n'est pas une anomalie.
 *
 * L'écran doit donc distinguer deux choses que le pack confond :
 *
 * - `materialise: false` — le rôle n'existe encore que comme template. C'est
 *   ce qui s'appliquera, ce n'est pas ce qui s'applique.
 * - `materialise: true` — une copie éditable vit en base pour ce projet.
 *
 * Afficher un rôle non matérialisé comme s'il était en place laisserait croire
 * qu'on peut l'éditer, alors qu'il n'y a rien à éditer.
 *
 * ## L'écart au template
 *
 * Le pack affiche « voir l'écart au template ». Il se mesure en comparant le
 * prompt de l'instance à celui du template dont elle est issue. On rend un
 * booléen et non un diff : produire un diff lisible est le travail de
 * l'écran, et l'envoyer à chaque chargement de la fiche coûterait deux prompts
 * complets par rôle pour une information qu'on ne regarde presque jamais.
 */

export interface ProjectRoleView {
  key: RoleKey
  /** Vrai quand une copie éditable existe pour ce projet. Faux : seul le template s'applique. */
  materialise: boolean
  /** Version du template de référence. `null` si aucun template ne porte cette clé. */
  templateVersion: number | null
  model: string | null
  enabled: boolean
  /**
   * Vrai quand le prompt de l'instance diffère de celui de son template.
   * `false` sur un rôle non matérialisé : il EST le template.
   */
  drift: boolean
}

/** Ordre du pipeline, pas ordre alphabétique : c'est ainsi que le pack les présente. */
const PIPELINE_ORDER: RoleKey[] = ['garant', 'dev', 'reviewer', 'judge', 'communicant', 'majordome']

export async function listProjectTeam(
  db: Kysely<Database>,
  projectId: string,
): Promise<ProjectRoleView[]> {
  const templates = await db
    .selectFrom('role_templates')
    .select(['id', 'key', 'version', 'model', 'system_prompt as systemPrompt'])
    .where('project_type', '=', 'generic')
    .orderBy('version', 'desc')
    .execute()

  // La version la plus haute par clé : la même que celle que
  // `resolveProjectRole` ira chercher.
  const latest = new Map<string, (typeof templates)[number]>()
  for (const t of templates) {
    if (!latest.has(t.key)) latest.set(t.key, t)
  }

  const instances = await db
    .selectFrom('roles')
    .select([
      'key',
      'model',
      'enabled',
      'template_id as templateId',
      'system_prompt as systemPrompt',
    ])
    .where('project_id', '=', projectId)
    .execute()
  const byKey = new Map(instances.map((r) => [r.key, r]))

  return PIPELINE_ORDER.filter((key) => latest.has(key) || byKey.has(key)).map((key) => {
    const template = latest.get(key)
    const instance = byKey.get(key)

    if (!instance) {
      return {
        key,
        materialise: false,
        templateVersion: template?.version ?? null,
        model: template?.model ?? null,
        // Un rôle non matérialisé est actif par défaut : rien ne l'a désactivé.
        enabled: true,
        drift: false,
      }
    }

    // Comparé au template dont l'instance est RÉELLEMENT issue quand on le
    // connaît, pas à la dernière version : un projet resté sur la v1 pendant
    // que le template passait en v3 n'a pas « dérivé », il n'a pas suivi.
    const origin = instance.templateId
      ? templates.find((t) => t.id === instance.templateId)
      : undefined
    const reference = origin ?? template
    return {
      key,
      materialise: true,
      templateVersion: reference?.version ?? null,
      model: instance.model,
      enabled: instance.enabled,
      drift: reference ? instance.systemPrompt !== reference.systemPrompt : false,
    }
  })
}

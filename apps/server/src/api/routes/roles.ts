import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '../../db/types'
import type { SettingsStore } from '../../settings/store'

/**
 * Deux sections de l'écran Réglages (`docs/design/Reglages.dc.html`) qui
 * n'avaient aucune API : les templates de rôles versionnés, et l'inventaire du
 * coffre.
 *
 * Les autres sections de cet écran sont déjà servies : le diagnostic
 * d'authentification par `/api/health/auth`, le budget et la réserve par
 * `/api/budget`, les alertes par `/api/settings`.
 */

export interface RolesRoutesDeps {
  db: Kysely<Database>
  settings: SettingsStore
}

export interface RoleTemplateView {
  key: string
  projectType: string
  version: number
  model: string | null
  /** Nombre de projets qui ont matérialisé ce template dans leur table `roles`. */
  usedByProjects: number
  /**
   * Le pack affiche « modifié le 2 août » à côté de chaque template. La table
   * `role_templates` n'a **aucune colonne d'horodatage** : ni `created_at`, ni
   * `updated_at`. On rend `null` plutôt qu'une date inventée ou la date du
   * jour — c'est à l'écran d'écrire « date inconnue », pas au serveur de
   * mentir. Ajouter la colonne demande une migration : à faire quand
   * l'édition des templates existera, puisque c'est elle qui donnera un sens à
   * la date.
   */
  modifiedAt: null
}

export interface VaultEntryView {
  /** Nom de la clé. **Jamais la valeur** : le coffre s'inventorie, il ne se lit pas par l'API. */
  key: string
}

export async function rolesRoutes(app: FastifyInstance, deps: RolesRoutesDeps): Promise<void> {
  /**
   * Les templates, groupés par (clé, type de projet), version la plus haute
   * d'abord — c'est celle qui s'applique.
   */
  app.get('/api/role-templates', { preHandler: app.requireAuth }, async () => {
    const templates = await deps.db
      .selectFrom('role_templates')
      .select(['id', 'key', 'project_type as projectType', 'version', 'model'])
      .orderBy('key', 'asc')
      .orderBy('version', 'desc')
      .execute()

    const usage = await deps.db
      .selectFrom('roles')
      .select('template_id as templateId')
      .where('template_id', 'is not', null)
      .execute()

    return templates.map(
      (t): RoleTemplateView => ({
        key: t.key,
        projectType: t.projectType,
        version: t.version,
        model: t.model,
        usedByProjects: usage.filter((u) => u.templateId === t.id).length,
        modifiedAt: null,
      }),
    )
  })

  /**
   * L'inventaire du coffre : les noms des secrets détenus, rien d'autre.
   *
   * `listPublic()` remplace déjà toute valeur scellée par `***`, mais on ne se
   * repose pas dessus : on ne renvoie ici que les clés, jamais le
   * dictionnaire. Une valeur ne peut pas fuir par un champ qu'on n'envoie pas.
   *
   * **Écart assumé avec le pack** : le prototype affiche pour chaque entrée sa
   * portée (client / projet / globe), les rôles qui peuvent la lire, la date
   * du dernier accès et une rotation automatique à 90 jours. Rien de tout cela
   * n'est modélisé : `settings` est une table de clés plates avec une valeur
   * scellée, sans portée ni journal d'accès. Ces champs ne sont pas rendus
   * vides ou à zéro — ils sont **absents**, pour que l'écran ne puisse pas
   * afficher « lisible par : personne » là où la vérité est « on ne sait pas ».
   * Un vrai coffre à portées est un sujet en soi, lié au journal d'audit.
   */
  app.get('/api/vault', { preHandler: app.requireAuth }, async () => {
    const all = await deps.settings.listPublic()
    const entries: VaultEntryView[] = Object.entries(all)
      .filter(([, value]) => value === '***')
      .map(([key]) => ({ key }))
      .sort((a, b) => a.key.localeCompare(b.key))
    return entries
  })
}

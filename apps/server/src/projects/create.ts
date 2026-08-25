import type { RoleKey } from '@silithid/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { archiver } from '../knowledge/store'

/**
 * Création d'un projet (`docs/design/Creation.dc.html`).
 *
 * ## Ce que cette fonction fait, et ce qu'elle ne fait pas
 *
 * Elle crée un projet et ses steps, dans une transaction. C'est tout.
 *
 * Elle ne crée **pas** le dépôt GitHub, ne provisionne **pas** le staging, ne
 * dépose **aucun** accès dans le coffre. Le prototype montre Hive annonçant
 * « repo créé ✓ · staging créé ✓ » — ce sont des gestes qui touchent des
 * services extérieurs, chacun avec ses identifiants et ses modes d'échec. Les
 * mélanger à l'écriture en base donnerait une création à moitié faite quand
 * l'un des deux échoue : un projet en base sans dépôt, ou un dépôt orphelin.
 * Ils viendront comme des étapes distinctes, chacune retentable.
 *
 * ## Le slug
 *
 * Dérivé du nom et désambiguïsé par un suffixe numérique, jamais un 409 —
 * même politique que `createGlobe`. C'est un écran de création, pas une API
 * publique où l'appelant choisirait son identifiant : « Boutique Bastide »
 * deux fois donne `boutique-bastide` puis `boutique-bastide-2`, et personne
 * n'a à comprendre pourquoi son nom serait « déjà pris ».
 *
 * ## Les steps
 *
 * Fournis par l'appelant. Le prototype montre Hive qui les propose et règle
 * leur mode de boucle step par step — cette proposition est le travail d'un
 * agent, pas d'une fonction de persistance. Ici on enregistre ce qui a été
 * décidé, quelle qu'en soit la provenance.
 */

export interface CreateStepInput {
  title: string
  specs: string
  /** `null` hérite du projet. Le mode `auto` ne porte QUE sur l'itération dev↔reviewer, jamais sur la prod. */
  autonomy?: 'gated' | 'auto' | null
  maxIterations?: number
}

/**
 * Un rôle que l'appelant veut voir différer du template.
 *
 * Le roster par défaut n'a pas à être fourni : `resolveProjectRole` matérialise
 * paresseusement chaque rôle depuis `role_templates` à sa première résolution.
 * On n'écrit ici QUE les écarts — un rôle absent de ce tableau garde le
 * comportement du template, et l'écran de création n'a pas à connaître la
 * liste des rôles pour créer un projet ordinaire.
 */
export interface CreateProjectRoleInput {
  key: RoleKey
  /**
   * `false` saute ce rôle. Effectif pour `reviewer` et `communicant`, dont les
   * handlers court-circuitent. `dev` et `garant` refusent : une boucle sans eux
   * n'a pas de sens, et l'accepter produirait un projet qui échoue au premier
   * run au lieu d'échouer ici, où l'erreur est lisible.
   */
  enabled?: boolean
  /** Prompt sur mesure. Absent, celui du template est copié tel quel. */
  systemPrompt?: string | null
}

/**
 * Un savoir déposé à la création, dans un cercle lié à ce projet.
 *
 * Le cercle `hive` est absent du type, volontairement : c'est le cercle racine,
 * les préférences transverses de Florian. Une création de projet n'a rien à y
 * écrire — un savoir semé là s'appliquerait à tous les projets, pour toujours,
 * parce qu'on a créé un projet une fois.
 */
export interface CreateProjectSavoirInput {
  cercle: 'projet' | 'client' | 'globe'
  sujet: string
  contenu: string
  stack?: string | null
  domaine?: 'code' | 'exploitation'
}

export interface CreateProjectInput {
  globeSlug: string
  name: string
  repoFullName: string
  clientId?: string | null
  stack?: string | null
  /**
   * `false` sur un projet sans interface : la boucle traverse `deploying` et
   * `judging` sans navigateur (migration 0014). Absent, la colonne vaut `true`.
   */
  jugeVisuel?: boolean
  tint?: string | null
  stagingUrl?: string | null
  steps?: CreateStepInput[]
  /** Écarts au roster par défaut. Voir `CreateProjectRoleInput`. */
  roster?: CreateProjectRoleInput[]
  /** Mémoire semée à la création, dans les cercles de ce projet. */
  savoirs?: CreateProjectSavoirInput[]
}

export interface CreatedProject {
  id: string
  slug: string
  name: string
  globeSlug: string
  stepCount: number
}

/**
 * Rôles dont la boucle ne peut pas se passer. Les désactiver produirait un
 * projet qui échoue au premier run, loin d'ici, avec un message qui ne
 * pointerait pas vers la décision fautive.
 */
const ROLES_INDISPENSABLES: readonly RoleKey[] = ['garant', 'dev']

export class RosterInvalideError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RosterInvalideError'
  }
}

export class UnknownGlobeError extends Error {
  constructor(slug: string) {
    super(`globe introuvable : ${slug}`)
    this.name = 'UnknownGlobeError'
  }
}

/** `a-z0-9` et tirets simples — même politique que les slugs de globe. */
function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'projet'
  )
}

export async function createProject(
  db: Kysely<Database>,
  input: CreateProjectInput,
): Promise<CreatedProject> {
  const globe = await db
    .selectFrom('globes')
    .select(['id', 'slug'])
    .where('slug', '=', input.globeSlug)
    .executeTakeFirst()
  // Un globe inconnu est une erreur de l'appelant, pas un cas à rattraper en
  // créant le globe au passage : `projects.globe_id` est NOT NULL et un globe
  // créé par effet de bord n'aurait ni teinte, ni mémoire, ni position.
  if (!globe) throw new UnknownGlobeError(input.globeSlug)

  for (const r of input.roster ?? []) {
    if (r.enabled === false && ROLES_INDISPENSABLES.includes(r.key)) {
      throw new RosterInvalideError(
        `le rôle "${r.key}" ne peut pas être désactivé · la boucle ne tourne pas sans lui`,
      )
    }
    // Le juge a déjà son interrupteur par projet (`projects.juge_visuel`).
    // Accepter le second le rendrait ambigu le jour où les deux se
    // contredisent : on refuse au lieu d'ignorer en silence.
    if (r.enabled !== undefined && r.key === 'judge') {
      throw new RosterInvalideError(
        'le juge se désactive par `jugeVisuel` sur le projet, pas par le roster',
      )
    }
  }

  // Transaction : un projet sans ses steps serait un projet qu'on ne peut pas
  // démarrer, affiché « prêt à démarrer » dans la liste. Les deux écritures
  // vivent ou meurent ensemble.
  return db.transaction().execute(async (trx) => {
    const base = slugify(input.name)
    let slug = base
    let suffix = 2
    while (
      await trx.selectFrom('projects').select('id').where('slug', '=', slug).executeTakeFirst()
    ) {
      slug = `${base}-${suffix}`
      suffix += 1
    }

    const project = await trx
      .insertInto('projects')
      .values({
        globe_id: globe.id,
        client_id: input.clientId ?? null,
        name: input.name,
        slug,
        repo_full_name: input.repoFullName,
        stack: input.stack ?? null,
        ...(input.jugeVisuel !== undefined ? { juge_visuel: input.jugeVisuel } : {}),
        tint: input.tint ?? null,
        staging_url: input.stagingUrl ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    const steps = input.steps ?? []
    for (const [index, step] of steps.entries()) {
      await trx
        .insertInto('steps')
        .values({
          project_id: project.id,
          // La position vient de l'ordre du tableau, jamais d'un champ fourni :
          // deux steps à la même position rendraient la timeline ambiguë.
          position: index + 1,
          title: step.title,
          specs: step.specs,
          autonomy: step.autonomy ?? null,
          max_iterations: step.maxIterations ?? 4,
        })
        .execute()
    }

    // Le roster : uniquement les écarts au template. Écrire une ligne `roles`
    // ici PRÉEMPTE la matérialisation paresseuse — `resolveProjectRole` donne
    // autorité à une ligne existante, donc ce qu'on écrit maintenant est ce que
    // la boucle utilisera, sans autre câblage.
    for (const r of input.roster ?? []) {
      const template = await trx
        .selectFrom('role_templates')
        .selectAll()
        .where('key', '=', r.key)
        .where('project_type', '=', 'generic')
        .orderBy('version', 'desc')
        .executeTakeFirst()
      if (!template) {
        throw new RosterInvalideError(`aucun role_template "${r.key}" — rôle inconnu`)
      }

      await trx
        .insertInto('roles')
        .values({
          project_id: project.id,
          template_id: template.id,
          key: template.key,
          // Le prompt sur mesure, ou la copie du template. `roles` porte
          // toujours un prompt complet : c'est ce qui rend la ligne éditable
          // sans avoir à retourner voir de quoi elle hérite.
          system_prompt: r.systemPrompt ?? template.system_prompt,
          tools: JSON.stringify(template.tools),
          model: template.model,
          ...(r.enabled !== undefined ? { enabled: r.enabled } : {}),
        })
        .execute()
    }

    // Les savoirs semés. `cercle_id` ne peut être résolu qu'ici : l'identifiant
    // du projet n'existe pas avant l'insertion, et un savoir de cercle `projet`
    // sans instance viole la contrainte du schéma.
    for (const sv of input.savoirs ?? []) {
      const cercleId =
        sv.cercle === 'projet' ? project.id : sv.cercle === 'globe' ? globe.id : input.clientId
      if (!cercleId) {
        throw new RosterInvalideError(
          `savoir « ${sv.sujet} » de cercle "client" mais le projet n'a pas de fiche client`,
        )
      }
      await archiver(trx, {
        cercle: sv.cercle,
        cercleId,
        sujet: sv.sujet,
        contenu: sv.contenu,
        stack: sv.stack ?? null,
        ...(sv.domaine ? { domaine: sv.domaine } : {}),
      })
    }

    return {
      id: project.id,
      slug,
      name: input.name,
      globeSlug: globe.slug,
      stepCount: steps.length,
    }
  })
}

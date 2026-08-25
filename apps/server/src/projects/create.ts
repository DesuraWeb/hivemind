import type { Kysely } from 'kysely'
import type { Database } from '../db/types'

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
}

export interface CreatedProject {
  id: string
  slug: string
  name: string
  globeSlug: string
  stepCount: number
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

    return {
      id: project.id,
      slug,
      name: input.name,
      globeSlug: globe.slug,
      stepCount: steps.length,
    }
  })
}

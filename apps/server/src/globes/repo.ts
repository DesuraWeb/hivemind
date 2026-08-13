import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { loopFromRunState } from '../projects/derive'

/**
 * Forme rendue par `GET /api/globes`. `id` est le `slug` (identifiant public
 * stable), même convention que `ProjectView` (projects/repo.ts) — la page
 * Globes route déjà tout par slug (`Inbox.dc.html`, `Dashboard.dc.html`).
 *
 * `nodes` n'existe pas plus pour un globe que pour un projet (plan Phase 3 :
 * ce sera dérivé de l'activité quand la conscience collective aura sa
 * propre volumétrie). En attendant, la taille de l'orbite se calcule sur
 * `projectCount` — un vrai nombre, pas une invention — documenté ci-dessous
 * plutôt que caché derrière un nom qui suggérerait une mesure de conscience
 * qui n'existe pas encore.
 */
export interface GlobeView {
  id: string
  name: string
  color: string | null
  position: number
  /** Nombre de projets rattachés — sert de poids réel pour la taille de l'orbite (cf. commentaire ci-dessus). */
  projectCount: number
  /** Projets dont la boucle courante avance (`loop === 'run'`). */
  activeCount: number
  /** Items d'inbox ouverts, tous projets du globe confondus. */
  pendingCount: number
}

interface GlobeRow {
  id: string
  name: string
  slug: string
  color: string | null
  position: number
}

async function toGlobeView(db: Kysely<Database>, row: GlobeRow): Promise<GlobeView> {
  // Une ligne par projet : `distinctOn` + tri par `started_at desc` retient le
  // run le plus récent (celui qui porte le statut affiché) — même principe
  // que `currentRun` (projects/repo.ts), généralisé à tous les projets d'un
  // coup plutôt qu'un aller-retour par projet.
  const latest = await db
    .selectFrom('projects')
    .leftJoin('steps', 'steps.project_id', 'projects.id')
    .leftJoin('runs', 'runs.step_id', 'steps.id')
    .distinctOn('projects.id')
    .select(['projects.id as projectId', 'runs.state as state'])
    .where('projects.globe_id', '=', row.id)
    .orderBy('projects.id')
    .orderBy('runs.started_at', 'desc')
    .execute()

  const projectIds = latest.map((p) => p.projectId)
  const activeCount = latest.filter((r) => loopFromRunState(r.state ?? null) === 'run').length

  let pendingCount = 0
  if (projectIds.length > 0) {
    const pending = await db
      .selectFrom('inbox_items')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('project_id', 'in', projectIds)
      .where('status', '=', 'open')
      .executeTakeFirst()
    pendingCount = Number(pending?.n ?? 0)
  }

  return {
    id: row.slug,
    name: row.name,
    color: row.color,
    position: row.position,
    projectCount: projectIds.length,
    activeCount,
    pendingCount,
  }
}

export async function listGlobes(db: Kysely<Database>): Promise<GlobeView[]> {
  const rows = await db
    .selectFrom('globes')
    .select(['id', 'name', 'slug', 'color', 'position'])
    .orderBy('position', 'asc')
    .execute()
  return Promise.all(rows.map((row) => toGlobeView(db, row)))
}

/** `a-z0-9` et tirets simples, jamais de tiret en tête/queue — même politique que les slugs projet (repo.ts existants). */
function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'globe'
  )
}

export interface CreateGlobeInput {
  name: string
  color?: string | null
}

/**
 * CRUD minimal (plan Phase 3, Task 8 : « formulaire simple ; la création
 * conversationnelle via Hive est une clause de débordement »). Le slug se
 * dérive du nom et se désambiguïse avec un suffixe numérique en cas de
 * collision — jamais d'erreur 409 pour un nom déjà pris, contrairement à un
 * slug fourni explicitement (comportement d'écran de formulaire, pas d'API
 * publique où l'appelant choisirait le slug).
 */
export async function createGlobe(
  db: Kysely<Database>,
  input: CreateGlobeInput,
): Promise<GlobeView> {
  const base = slugify(input.name)
  let slug = base
  let suffix = 2
  while (await db.selectFrom('globes').select('id').where('slug', '=', slug).executeTakeFirst()) {
    slug = `${base}-${suffix}`
    suffix += 1
  }

  const maxPosition = await db
    .selectFrom('globes')
    .select((eb) => eb.fn.max('position').as('max'))
    .executeTakeFirst()
  const position = (maxPosition?.max ?? -1) + 1

  const row = await db
    .insertInto('globes')
    .values({ name: input.name, slug, color: input.color ?? null, position })
    .returning(['id', 'name', 'slug', 'color', 'position'])
    .executeTakeFirstOrThrow()

  return toGlobeView(db, row)
}

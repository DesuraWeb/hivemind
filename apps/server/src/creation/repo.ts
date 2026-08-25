import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/types'
import type { Fiche } from './fiche'

/** Un tour de parole. `de` n'est pas un `RoleKey` : Florian n'est pas un agent. */
export interface TourCreation {
  de: 'hive' | 'florian'
  texte: string
  a: string
  /**
   * Une panne, dite à la place de la réplique. La règle de Florian est
   * d'apprendre un échec depuis l'écran où il se produit, jamais en lisant les
   * logs — donc l'échec est un tour du fil, pas une entrée de journal.
   */
  panne?: boolean
}

export interface Creation {
  id: string
  fiche: Fiche
  conversation: TourCreation[]
  statut: 'en_cours' | 'aboutie' | 'abandonnee'
  globeId: string | null
  projectId: string | null
  costTokens: number
}

const COLONNES = [
  'id',
  'fiche',
  'conversation',
  'statut',
  'globe_id as globeId',
  'project_id as projectId',
  'cost_tokens as costTokens',
] as const

function versCreation(r: Record<string, unknown>): Creation {
  return {
    id: r.id as string,
    fiche: (r.fiche ?? {}) as Fiche,
    conversation: (r.conversation ?? []) as TourCreation[],
    statut: r.statut as Creation['statut'],
    globeId: (r.globeId ?? null) as string | null,
    projectId: (r.projectId ?? null) as string | null,
    // `bigint` revient en chaîne du pilote pg : le laisser tel quel ferait une
    // concaténation au lieu d'une addition au tour suivant.
    costTokens: Number(r.costTokens ?? 0),
  }
}

export async function ouvrirCreation(db: Kysely<Database>): Promise<Creation> {
  const ligne = await db
    .insertInto('creations')
    .values({ globe_id: null, project_id: null })
    .returning(COLONNES)
    .executeTakeFirstOrThrow()
  return versCreation(ligne as Record<string, unknown>)
}

export async function lireCreation(db: Kysely<Database>, id: string): Promise<Creation | null> {
  const ligne = await db
    .selectFrom('creations')
    .select(COLONNES)
    .where('id', '=', id)
    .executeTakeFirst()
  return ligne ? versCreation(ligne as Record<string, unknown>) : null
}

/**
 * La création en cours la plus récente, s'il y en a une.
 *
 * C'est ce qui fait qu'un rafraîchissement, ou un onglet rouvert le lendemain,
 * retombe sur la conversation en cours plutôt que d'en ouvrir une vierge à
 * côté. Sans ça, une discussion payée à un modèle disparaîtrait à la moindre
 * fausse manœuvre.
 */
export async function creationEnCours(db: Kysely<Database>): Promise<Creation | null> {
  const ligne = await db
    .selectFrom('creations')
    .select(COLONNES)
    .where('statut', '=', 'en_cours')
    .orderBy('updated_at', 'desc')
    .executeTakeFirst()
  return ligne ? versCreation(ligne as Record<string, unknown>) : null
}

export interface EnregistrerTourInput {
  fiche: Fiche
  conversation: TourCreation[]
  /** Ajouté au cumul, jamais écrasé : le budget doit voir la conversation entière. */
  costTokens?: number
}

export async function enregistrerTour(
  db: Kysely<Database>,
  id: string,
  input: EnregistrerTourInput,
): Promise<Creation> {
  const ligne = await db
    .updateTable('creations')
    .set({
      fiche: JSON.stringify(input.fiche),
      conversation: JSON.stringify(input.conversation),
      // Cumulé côté base : deux tours qui reviennent en même temps ne doivent
      // pas s'écraser l'un l'autre sur un compteur lu puis réécrit.
      cost_tokens: sql`cost_tokens + ${input.costTokens ?? 0}`,
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .returning(COLONNES)
    .executeTakeFirstOrThrow()
  return versCreation(ligne as Record<string, unknown>)
}

/**
 * Une correction humaine. N'écrit QUE la fiche : réécrire le fil parce qu'on a
 * corrigé un nom de dépôt falsifierait ce que Hive a réellement dit.
 */
export async function corrigerFiche(
  db: Kysely<Database>,
  id: string,
  fiche: Fiche,
): Promise<Creation> {
  const ligne = await db
    .updateTable('creations')
    .set({ fiche: JSON.stringify(fiche), updated_at: sql`now()` })
    .where('id', '=', id)
    .returning(COLONNES)
    .executeTakeFirstOrThrow()
  return versCreation(ligne as Record<string, unknown>)
}

/**
 * Rattache à la création ce qu'elle a écrit en base.
 *
 * `aboutie` est explicite parce qu'une orbe créée n'est qu'une étape : la
 * conversation continue jusqu'au projet. Clore sur l'orbe rendrait l'écran
 * muet au milieu du travail.
 */
export async function cloturerCreation(
  db: Kysely<Database>,
  id: string,
  quoi: { globeId?: string | null; projectId?: string | null; aboutie?: boolean },
): Promise<Creation> {
  const ligne = await db
    .updateTable('creations')
    .set({
      ...(quoi.aboutie ? { statut: 'aboutie' as const } : {}),
      ...(quoi.globeId !== undefined ? { globe_id: quoi.globeId } : {}),
      ...(quoi.projectId !== undefined ? { project_id: quoi.projectId } : {}),
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .returning(COLONNES)
    .executeTakeFirstOrThrow()
  return versCreation(ligne as Record<string, unknown>)
}

export async function abandonnerCreation(db: Kysely<Database>, id: string): Promise<void> {
  await db
    .updateTable('creations')
    .set({ statut: 'abandonnee', updated_at: sql`now()` })
    .where('id', '=', id)
    .execute()
}

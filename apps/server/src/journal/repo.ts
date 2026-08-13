import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/types'

/**
 * Le journal (`docs/design/Journal.dc.html`), deux onglets : « Nuit des
 * agents » et « Vos décisions ».
 *
 * ## Aucune table nouvelle, et c'est volontaire
 *
 * Tout est déjà écrit. Les passations entre agents vivent dans `messages`
 * (c'est la piste d'audit du projet depuis la Phase 2 : rien ne circule entre
 * deux rôles sans y passer). Les arbitrages humains vivent dans
 * `inbox_items.human_response`, avec `resolved_at`.
 *
 * Créer une table `journal` reviendrait à recopier ces deux sources, donc à
 * créer une seconde vérité qui divergerait au premier crash. Le journal est
 * une LECTURE, pas un stockage. Même raisonnement que `projects/derive.ts`
 * pour le statut d'un projet, qui n'est jamais stocké non plus.
 *
 * ## Ce qui n'est pas là : la révocation
 *
 * Le prototype permet de révoquer une décision (« Repasser en gates »,
 * « Revenir à 4 »), et précise que chaque révocation est elle-même
 * journalisée. Ce n'est pas implémenté, et ce n'est pas un oubli de câblage :
 * révoquer suppose de savoir DÉFAIRE chaque type de décision, ce qui est un
 * geste différent pour chacune — remettre des gates, redescendre un
 * `max_iterations`, rappeler un email déjà parti (impossible). Il n'y a pas de
 * « révocation » générique à écrire ; il y a autant de gestes que de types de
 * décision, et chacun mérite d'être décidé.
 *
 * Le champ `revocable` ci-dessous dit donc `false` partout, honnêtement,
 * plutôt que d'afficher un bouton qui ne ferait rien.
 */

/** 90 jours, comme l'annonce le pied de l'écran (« conservé 90 j »). */
export const JOURNAL_RETENTION_DAYS = 90

export interface NightEntry {
  id: string
  at: string
  /** Rôle émetteur de la passation : c'est lui qui colore la ligne dans le pack. */
  role: string
  toRole: string
  kind: string
  text: string
  projectId: string | null
  projectName: string | null
  runId: string
}

export interface DecisionEntry {
  id: string
  at: string
  /** Type d'item résolu (`approval`/`prod`, `question`…) : la catégorie affichée en majuscules. */
  kind: string
  subtype: string | null
  title: string
  /** Ce que l'humain a réellement répondu, tel qu'enregistré. */
  response: unknown
  projectId: string | null
  projectName: string | null
  /** Toujours `false` aujourd'hui — voir la note de tête. */
  revocable: false
}

export interface JournalWindow {
  since: string
  until: string
}

/**
 * La « nuit » : les passations d'agents sur une fenêtre. Le pack la présente
 * comme une nuit, mais rien ici n'impose un créneau nocturne — c'est l'appelant
 * qui borne, et le nom vient de l'usage (Florian lit le matin ce qui s'est
 * passé pendant qu'il dormait), pas d'une contrainte technique.
 */
export async function listNight(
  db: Kysely<Database>,
  window: { since: Date; until: Date },
  limit = 200,
): Promise<NightEntry[]> {
  const rows = await db
    .selectFrom('messages')
    .innerJoin('runs', 'runs.id', 'messages.run_id')
    .innerJoin('steps', 'steps.id', 'runs.step_id')
    .innerJoin('projects', 'projects.id', 'steps.project_id')
    .select([
      'messages.id as id',
      'messages.from_role as fromRole',
      'messages.to_role as toRole',
      'messages.kind as kind',
      'messages.body as body',
      'messages.created_at as createdAt',
      // `runs.id` plutôt que `messages.run_id` : cette colonne est nullable au
      // schéma, et l'innerJoin garantit qu'elle ne l'est pas ici. Lire l'id du
      // run évite d'affirmer à TypeScript ce qu'il ne peut pas vérifier.
      'runs.id as runId',
      'projects.slug as projectId',
      'projects.name as projectName',
    ])
    .where(sql<boolean>`messages.created_at >= ${window.since}`)
    .where(sql<boolean>`messages.created_at <= ${window.until}`)
    .orderBy('messages.created_at', 'desc')
    .limit(limit)
    .execute()

  return rows.map((r) => ({
    id: r.id,
    at: new Date(r.createdAt as unknown as string).toISOString(),
    role: r.fromRole,
    toRole: r.toRole,
    kind: r.kind,
    // Le corps complet, jamais tronqué côté serveur : c'est une piste d'audit,
    // et c'est l'écran qui décide ce qu'il replie.
    text: r.body,
    projectId: r.projectId,
    projectName: r.projectName,
    runId: r.runId,
  }))
}

/**
 * « Vos décisions » : les items d'inbox que Florian a réellement tranchés.
 *
 * Un item `dismissed` compte comme une décision — écarter est un arbitrage,
 * pas une absence d'arbitrage. Un item encore `open` n'en est pas une.
 */
export async function listDecisions(
  db: Kysely<Database>,
  window: { since: Date; until: Date },
  limit = 200,
): Promise<DecisionEntry[]> {
  const rows = await db
    .selectFrom('inbox_items')
    .leftJoin('projects', 'projects.id', 'inbox_items.project_id')
    .select([
      'inbox_items.id as id',
      'inbox_items.type as type',
      'inbox_items.subtype as subtype',
      'inbox_items.title as title',
      'inbox_items.human_response as humanResponse',
      'inbox_items.resolved_at as resolvedAt',
      'projects.slug as projectId',
      'projects.name as projectName',
    ])
    .where('inbox_items.status', '!=', 'open')
    .where('inbox_items.resolved_at', 'is not', null)
    .where(sql<boolean>`inbox_items.resolved_at >= ${window.since}`)
    .where(sql<boolean>`inbox_items.resolved_at <= ${window.until}`)
    .orderBy('inbox_items.resolved_at', 'desc')
    .limit(limit)
    .execute()

  return rows.map((r) => ({
    id: r.id,
    at: new Date(r.resolvedAt as unknown as string).toISOString(),
    kind: r.type,
    subtype: r.subtype,
    title: r.title,
    response: r.humanResponse,
    projectId: r.projectId,
    projectName: r.projectName,
    revocable: false as const,
  }))
}

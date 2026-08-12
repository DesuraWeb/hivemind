import type { InboxStatus, InboxType } from '@silithid/shared'
import type { Kysely, Selectable } from 'kysely'
import { sql } from 'kysely'
import type { Database, InboxItemsTable } from '../db/types'

/**
 * Forme exposée hors DB. Volontairement pas d'`age`/`ageMin` ici : ce sont
 * des valeurs d'affichage (brief, cf. plan Phase 3), calculées côté front à
 * partir de `blockedSince` (items bloquants) ou `createdAt` (les autres). Les
 * stocker créerait une valeur qui se périme dès que l'horloge tourne.
 */
export interface InboxItemRow {
  id: string
  type: InboxType
  subtype: string | null
  projectId: string | null
  runId: string | null
  title: string
  /** Rôle qui a levé l'item (garant, dev, communicant, boucle dev…). */
  fromRole: string | null
  payload: Record<string, unknown>
  status: InboxStatus
  humanResponse: Record<string, unknown> | null
  createdAt: Date
  blockedSince: Date
  resolvedAt: Date | null
  archiveToClient: boolean
}

/** Exporté pour `resolve.ts` : évite une relecture après l'`update` déjà fait dans la transaction. */
export function toInboxItemRow(row: Selectable<InboxItemsTable>): InboxItemRow {
  return {
    id: row.id,
    type: row.type,
    subtype: row.subtype,
    projectId: row.project_id,
    runId: row.run_id,
    title: row.title,
    fromRole: row.from_role,
    payload: row.payload,
    status: row.status,
    humanResponse: row.human_response ?? null,
    // `Timestamp` est un ColumnType : à la lecture le driver rend un Date,
    // mais le type déclaré couvre aussi les formes acceptées à l'écriture
    // (cf. le même commentaire dans bus.ts) — d'où le passage explicite par
    // `new Date(...)`.
    createdAt: new Date(row.created_at as unknown as string),
    blockedSince: new Date(row.blocked_since as unknown as string),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as unknown as string) : null,
    archiveToClient: row.archive_to_client,
  }
}

export interface ListInboxFilters {
  status?: InboxStatus
  type?: InboxType
  projectId?: string
}

/**
 * Liste triée pour l'UI : items ouverts d'abord, puis plus anciens en tête.
 *
 * `blocked_since` est non-nullable et vaut `created_at` à la création de
 * chaque item (migration 0001) — aucun code n'écrit encore `blocked_since`
 * séparément de `created_at`. Trier sur `blocked_since` couvre donc déjà les
 * deux cas demandés (bloquants vs non bloquants) : c'est la même valeur tant
 * que rien ne les dissocie. Le jour où un item bloquant voit son horodatage
 * de blocage bougé indépendamment de sa création, ce tri restera correct sans
 * modification — c'est précisément la colonne conçue pour ça.
 */
export async function listInbox(
  db: Kysely<Database>,
  filters: ListInboxFilters = {},
): Promise<InboxItemRow[]> {
  let query = db.selectFrom('inbox_items').selectAll()

  if (filters.status) query = query.where('status', '=', filters.status)
  if (filters.type) query = query.where('type', '=', filters.type)
  if (filters.projectId) query = query.where('project_id', '=', filters.projectId)

  const rows = await query
    .orderBy(sql`case when status = 'open' then 0 else 1 end`)
    .orderBy('blocked_since', 'asc')
    .orderBy('id', 'asc')
    .execute()

  return rows.map(toInboxItemRow)
}

export async function getInboxItem(
  db: Kysely<Database>,
  id: string,
): Promise<InboxItemRow | undefined> {
  const row = await db.selectFrom('inbox_items').selectAll().where('id', '=', id).executeTakeFirst()
  return row ? toInboxItemRow(row) : undefined
}

export interface CreateInboxItemInput {
  type: InboxType
  subtype?: string | null
  /** `null` : alerte système sans projet ni run (ex. échec du healthcheck d'auth). */
  projectId?: string | null
  runId?: string | null
  title: string
  fromRole?: string | null
  payload?: Record<string, unknown>
  /** Défaut DB : `true` (migration 0001). Omis ⇒ hérite du défaut. */
  archiveToClient?: boolean
}

/**
 * Entrée directe pour les items qui ne naissent pas d'un `Effect` de la
 * machine à états (alertes système, items créés par un handler hors boucle).
 * `applyEvent`/`applyEffect` (orchestrator.ts) restent le seul chemin pour un
 * item produit par une transition de run — on n'y touche pas ici.
 */
export async function createInboxItem(
  db: Kysely<Database>,
  input: CreateInboxItemInput,
): Promise<InboxItemRow> {
  const row = await db
    .insertInto('inbox_items')
    .values({
      type: input.type,
      subtype: input.subtype ?? null,
      project_id: input.projectId ?? null,
      run_id: input.runId ?? null,
      title: input.title,
      from_role: input.fromRole ?? null,
      payload: JSON.stringify(input.payload ?? {}),
      ...(input.archiveToClient !== undefined ? { archive_to_client: input.archiveToClient } : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return toInboxItemRow(row)
}

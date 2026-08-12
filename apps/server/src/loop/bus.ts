import type { MessageKind, RoleKey } from '@silithid/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'

export interface OutgoingMessage {
  runId: string
  fromRole: RoleKey | 'system'
  toRole: RoleKey | 'system'
  kind: MessageKind
  body: string
  meta?: Record<string, unknown>
}

export interface StoredMessage {
  id: string
  fromRole: string
  toRole: string
  kind: string
  body: string
  meta: Record<string, unknown>
  createdAt: Date
}

/**
 * Écrit une passation dans le bus. C'est la piste d'audit du sprint : la DoD
 * exige que tout message inter-agents soit consultable dans la timeline, donc
 * rien ne circule entre deux rôles sans passer ici.
 */
export async function appendMessage(db: Kysely<Database>, msg: OutgoingMessage): Promise<void> {
  await db
    .insertInto('messages')
    .values({
      run_id: msg.runId,
      from_role: msg.fromRole,
      to_role: msg.toRole,
      kind: msg.kind,
      body: msg.body,
      meta: JSON.stringify(msg.meta ?? {}),
    })
    .execute()
}

/** Timeline d'un run, du plus ancien au plus récent. */
export async function readRunMessages(
  db: Kysely<Database>,
  runId: string,
): Promise<StoredMessage[]> {
  const rows = await db
    .selectFrom('messages')
    .selectAll()
    .where('run_id', '=', runId)
    // `id` départage les messages écrits dans la même milliseconde : trier sur
    // created_at seul rendrait l'ordre d'une passation non déterministe.
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute()

  return rows.map((r) => ({
    id: String(r.id),
    fromRole: r.from_role,
    toRole: r.to_role,
    kind: r.kind,
    body: r.body,
    meta: r.meta as Record<string, unknown>,
    // `Timestamp` est un ColumnType : à la lecture le driver rend un Date,
    // mais le type déclaré couvre aussi les formes acceptées à l'écriture.
    createdAt: new Date(r.created_at as unknown as string),
  }))
}

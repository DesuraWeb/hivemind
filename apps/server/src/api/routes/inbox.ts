import { INBOX_STATUSES, INBOX_TYPES } from '@silithid/shared'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { z } from 'zod'
import type { Database } from '../../db/types'
import { type InboxItemRow, listInbox } from '../../inbox/repo'
import { type InboxResponse, resolveInboxItem } from '../../inbox/resolve'

export interface InboxRoutesDeps {
  db: Kysely<Database>
  boss: PgBoss
}

/** `status=` / `type=` / `project=` vides : traités comme absents, pas comme invalides — cf. le gabarit de route du brief §8. */
const emptyToUndefined = (v: unknown): unknown => (v === '' ? undefined : v)

const listQuery = z.object({
  status: z.preprocess(emptyToUndefined, z.enum(INBOX_STATUSES).optional()),
  type: z.preprocess(emptyToUndefined, z.enum(INBOX_TYPES).optional()),
  project: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
})

const resolveParams = z.object({ id: z.string().uuid() })

/** Miroir de `InboxResponse` (resolve.ts) : `text`, s'il est présent, doit être une chaîne — le reste passe tel quel. */
const humanResponseSchema = z.object({ text: z.string().optional() }).passthrough()
const resolveBody = z.object({ response: humanResponseSchema })

/**
 * zod rend les clés optionnelles comme `T | undefined` explicitement, jamais
 * seulement absentes — incompatible avec `exactOptionalPropertyTypes` (tsconfig)
 * et le type `InboxResponse` de resolve.ts (`text?: string`, pas `string |
 * undefined`). On ne recopie `text` que s'il a réellement été fourni.
 */
function toInboxResponse(parsed: z.infer<typeof humanResponseSchema>): InboxResponse {
  const { text, ...rest } = parsed
  return text === undefined ? rest : { ...rest, text }
}

/**
 * `project_id` (uuid interne) → `slug` (identifiant public, même forme que
 * `GET /api/projects`). Une seule requête pour tous les items de la page,
 * plutôt qu'un aller-retour par item.
 */
async function projectSlugMap(
  db: Kysely<Database>,
  projectIds: string[],
): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('projects')
    .select(['id', 'slug'])
    .where('id', 'in', projectIds)
    .execute()
  return new Map(rows.map((r) => [r.id, r.slug]))
}

/**
 * Forme rendue par l'API : les clés suivent `INBOX[]` de data.js (id, type,
 * sub, title, project, agent), à une différence près et volontaire —
 * `age`/`ageMin` sont retirés : ce sont des valeurs d'affichage qui se
 * périment dès que l'horloge tourne (plan Phase 3, Task 4 : « Rends
 * blockedSince et createdAt bruts ; le front calcule »). `status` est ajouté
 * : sans lui, un appel sans filtre `status` ne permettrait pas de distinguer
 * un item ouvert d'un item déjà résolu.
 */
function toApiItem(item: InboxItemRow, projectSlug: string | null) {
  return {
    id: item.id,
    type: item.type,
    // `sub` omis (pas `null`) quand il n'y a pas de sous-type : réplique le
    // literal object de data.js, où la clé est absente plutôt que nulle.
    ...(item.subtype ? { sub: item.subtype } : {}),
    title: item.title,
    project: projectSlug,
    agent: item.fromRole,
    status: item.status,
    blockedSince: item.blockedSince.toISOString(),
    createdAt: item.createdAt.toISOString(),
  }
}

export async function inboxRoutes(app: FastifyInstance, deps: InboxRoutesDeps): Promise<void> {
  app.get('/api/inbox', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'requete_invalide' })

    let projectId: string | undefined
    if (parsed.data.project) {
      const row = await deps.db
        .selectFrom('projects')
        .select('id')
        .where('slug', '=', parsed.data.project)
        .executeTakeFirst()
      // Slug de filtre inconnu : liste vide, pas une erreur. C'est un filtre
      // sur une collection, pas l'accès à une ressource précise — le 404 est
      // réservé aux routes `/:id` (cf. POST /resolve, GET /projects/:id...).
      if (!row) return []
      projectId = row.id
    }

    const items = await listInbox(deps.db, {
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.type ? { type: parsed.data.type } : {}),
      ...(projectId ? { projectId } : {}),
    })

    const ids = [
      ...new Set(items.map((i) => i.projectId).filter((id): id is string => id !== null)),
    ]
    const slugs = await projectSlugMap(deps.db, ids)
    return items.map((item) =>
      toApiItem(item, item.projectId ? (slugs.get(item.projectId) ?? null) : null),
    )
  })

  app.post('/api/inbox/:id/resolve', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = resolveParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'id_invalide' })

    const body = resolveBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'requete_invalide' })

    try {
      const result = await resolveInboxItem(
        deps.db,
        deps.boss,
        params.data.id,
        toInboxResponse(body.data.response),
      )
      const slug = result.item.projectId
        ? ((await projectSlugMap(deps.db, [result.item.projectId])).get(result.item.projectId) ??
          null)
        : null
      return { item: toApiItem(result.item, slug), runResumed: result.runResumed }
    } catch (err) {
      // `resolve.ts` (Task 2, non modifié ici) n'expose que des `Error`
      // génériques — matcher le message est le seul signal disponible sans
      // changer sa signature. Couplage fragile mais volontaire, déjà accepté
      // par les tests de Task 2 (`rejects.toThrow(/déjà résolu/)`).
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('introuvable'))
        return reply.code(404).send({ error: 'item_introuvable' })
      if (message.includes('déjà résolu')) return reply.code(409).send({ error: 'deja_resolu' })
      throw err
    }
  })
}

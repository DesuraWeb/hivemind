import { INBOX_STATUSES, INBOX_TYPES } from '@silithid/shared'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { z } from 'zod'
import { sendApprovedClientEmail } from '../../communication/client-email'
import { sujetDepuisProd } from '../../communication/invoke'
import type { Database } from '../../db/types'
import { optimizeAnswer } from '../../inbox/optimize'
import { type InboxItemRow, createInboxItem, getInboxItem, listInbox } from '../../inbox/repo'
import { type InboxResponse, resolveInboxItem } from '../../inbox/resolve'
import type { GmailSendPort } from '../../integrations/gmail'
import { COMMUNICANT_QUEUE, type CommunicantJobData } from '../../jobs/communicant'
import { OPS_APPLY_QUEUE, type OpsApplyJobData } from '../../jobs/ops-apply'
import { archiverSavoirApprouve } from '../../knowledge/propose'
import { apprendreDuRetour } from '../../ops/apprendre'
import { OPS_INBOX_SUBTYPE } from '../../ops/change-request'
import { ajouterEtapeApprouvee } from '../../ops/recipe-proposal'
import type { RuntimeAdapter } from '../../runtime/types'
import type { SettingsStore } from '../../settings/store'

export interface InboxRoutesDeps {
  db: Kysely<Database>
  boss: PgBoss
  adapter: RuntimeAdapter
  settings: SettingsStore
  /**
   * Envoi d'un email client, côté serveur uniquement (Task 5, Phase 5). Cette
   * route est le SEUL appelant : c'est ici qu'une validation humaine devient
   * un envoi, et nulle part ailleurs. Aucun agent n'atteint ce port.
   */
  gmailSender: GmailSendPort
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

const optimizeParams = z.object({ id: z.string().uuid() })
/** `text` : la réponse brute telle que tapée dans le champ — vide refusé, rien à optimiser. */
const optimizeBody = z.object({ text: z.string().min(1) })

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
 * sub, title, project, agent), à des différences près et volontaires —
 * `age`/`ageMin` sont retirés : ce sont des valeurs d'affichage qui se
 * périment dès que l'horloge tourne (plan Phase 3, Task 4 : « Rends
 * blockedSince et createdAt bruts ; le front calcule »). `status` est ajouté
 * : sans lui, un appel sans filtre `status` ne permettrait pas de distinguer
 * un item ouvert d'un item déjà résolu.
 *
 * `payload` et `archiveToClient` sont ajoutés pour la Task 7 (écran Inbox) :
 * les 5 panneaux de traitement ont besoin du contenu structuré de l'item
 * (brouillon d'email, rapport de verdict, cause d'alerte…) pour s'afficher,
 * et `archiveToClient` est affiché en lecture seule dans le panneau question
 * — c'est un réglage figé à la création de l'item (resolve.ts, Task 2), pas
 * quelque chose que la résolution peut changer.
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
    payload: item.payload,
    archiveToClient: item.archiveToClient,
  }
}

/**
 * Suite serveur d'une validation : un item `approval`/`email` approuvé fait
 * partir le brouillon Gmail correspondant. Tout le reste rend `false` sans
 * rien faire.
 *
 * L'échec d'envoi ne fait pas échouer la requête : l'item est déjà résolu, le
 * rejouer produirait un doublon (`resolveInboxItem` refuse un item non
 * `open`). Il lève un `alert` en inbox, parce qu'un email client approuvé qui
 * n'est jamais parti doit se voir : une ligne de log ne se voit pas.
 */
async function sendApprovedEmailOrAlert(
  deps: InboxRoutesDeps,
  item: InboxItemRow,
  log: FastifyBaseLogger,
): Promise<boolean> {
  try {
    const sent = await sendApprovedClientEmail(deps.db, deps.gmailSender, item)
    return sent !== null
  } catch (err) {
    log.error({ err, itemId: item.id }, "envoi de l'email client approuvé échoué")
    await createInboxItem(deps.db, {
      type: 'alert',
      projectId: item.projectId,
      runId: item.runId,
      title: `Envoi impossible · ${item.title}`,
      fromRole: 'system',
      payload: {
        sourceItemId: item.id,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return false
  }
}

/**
 * Suite serveur d'une proposition de savoir (Phase 7, Task 3) : un item
 * `approval`/`savoir` approuvé archive le savoir dans le cercle visé, avec la
 * formulation de Florian si elle a été corrigée. Un refus n'archive rien.
 *
 * Même traitement d'erreur que l'envoi d'email : l'item est déjà résolu, le
 * rejouer est impossible, donc l'échec lève une alerte au lieu de disparaître
 * dans un log. Un savoir validé qui ne serait jamais entré en mémoire est
 * exactement le genre de perte silencieuse que cette phase existe pour
 * éviter.
 */
async function archiveSavoirOrAlert(
  deps: InboxRoutesDeps,
  item: InboxItemRow,
  log: FastifyBaseLogger,
): Promise<boolean> {
  try {
    return (await archiverSavoirApprouve(deps.db, item)) !== null
  } catch (err) {
    log.error({ err, itemId: item.id }, 'archivage du savoir approuvé échoué')
    await createInboxItem(deps.db, {
      type: 'alert',
      projectId: item.projectId,
      runId: item.runId,
      title: `Archivage impossible · ${item.title}`,
      fromRole: 'system',
      payload: {
        sourceItemId: item.id,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return false
  }
}

/**
 * Suite serveur d'une mise en prod approuvée : faire proposer au communicant
 * un email au client (Phase 5, Task 5 · câblé pour de bon).
 *
 * Le communicant savait rédiger depuis la Phase 5 et personne ne l'appelait
 * jamais. C'est ici qu'il est réveillé, parce que c'est ici — et nulle part
 * ailleurs dans la boucle — que quelque chose change du point de vue du
 * client (voir `communication/invoke.ts` pour l'arbitrage complet).
 *
 * Enfilé, pas exécuté : la rédaction est un échange modèle complet, et
 * Florian vient seulement de cliquer « approuver ». Le faire attendre
 * plusieurs dizaines de secondes derrière un brouillon qu'il n'a pas demandé
 * serait une punition pour avoir validé une mise en ligne.
 *
 * L'échec d'enfilage ne fait pas échouer la requête, et ne lève PAS d'alerte
 * en inbox, contrairement aux deux suites ci-dessus. La différence est
 * réelle : un email approuvé qui ne part pas et un savoir validé qui n'entre
 * pas en mémoire sont des pertes — un humain avait décidé, sa décision a
 * disparu. Ici personne n'a rien décidé encore : c'est une proposition qui
 * n'a pas abouti. La tracer en inbox ajouterait du bruit à l'endroit exact
 * que ce projet existe pour désencombrer. Elle est journalisée, et Florian
 * garde la route à la demande.
 */
async function enqueueClientEmailDraft(
  deps: InboxRoutesDeps,
  item: InboxItemRow,
  log: FastifyBaseLogger,
): Promise<boolean> {
  if (item.type !== 'approval' || item.subtype !== 'prod') return false
  if (item.humanResponse?.approved !== true) return false
  if (!item.projectId) return false

  try {
    await deps.boss.send(COMMUNICANT_QUEUE, {
      projectId: item.projectId,
      runId: item.runId,
      sujet: sujetDepuisProd(item.title, item.payload),
    } satisfies CommunicantJobData)
    return true
  } catch (err) {
    log.error({ err, itemId: item.id }, 'mise en file de la rédaction client échouée')
    return false
  }
}

/**
 * Suite serveur d'un changement d'exploitation approuvé : Silithid applique.
 *
 * C'est la demande explicite de Florian — « j'ai pas envie de me rendre fou à
 * aller taper des commandes moi-même, mais par contre avec validation ». On
 * ne se contente donc pas de lui montrer la commande : elle part.
 *
 * Enfilé, pas exécuté : un `apt-get install` sur un serveur lent prend une
 * minute, et faire expirer la requête laisserait Florian sans savoir si son
 * changement est parti — l'incertitude la plus désagréable de toutes sur une
 * machine de production. Le résultat s'écrit ensuite dans l'item lui-même
 * (`payload.applique`), et un échec lève une alerte.
 *
 * Le plan qui s'exécutera est celui que l'item porte, vérifié par empreinte au
 * moment de l'exécution (`ops/change-request.ts`) : ce qui part est ce qui a
 * été montré, même si quelqu'un a édité l'item entre-temps.
 */
async function enqueueOpsApply(
  deps: InboxRoutesDeps,
  item: InboxItemRow,
  log: FastifyBaseLogger,
): Promise<boolean> {
  if (item.type !== 'approval' || item.subtype !== OPS_INBOX_SUBTYPE) return false
  if (item.humanResponse?.approved !== true) return false

  try {
    await deps.boss.send(OPS_APPLY_QUEUE, { inboxItemId: item.id } satisfies OpsApplyJobData)
    return true
  } catch (err) {
    // Ici, contrairement à la rédaction client, l'échec MÉRITE une alerte : un
    // humain a décidé qu'un serveur devait changer, et sa décision est en
    // train de se perdre. Ce n'est pas une proposition qui n'aboutit pas.
    log.error({ err, itemId: item.id }, 'mise en file du changement serveur échouée')
    await createInboxItem(deps.db, {
      type: 'alert',
      projectId: item.projectId,
      runId: item.runId,
      fromRole: 'system',
      title: `Changement non appliqué · ${item.title}`,
      payload: {
        cause: 'la mise en file a échoué · le changement approuvé n’a pas démarré',
        sourceItemId: item.id,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return false
  }
}

/**
 * Source 2 de l'apprentissage d'exploitation : ce que Florian a écrit en
 * validant (ou en refusant) un plan serveur.
 *
 * C'est le signal le plus précieux des trois. Un refus motivé porte un
 * arbitrage humain qu'aucun agent n'aurait deviné — sans cette source, il
 * faudrait le redonner à chaque déploiement sur la même stack.
 *
 * Ne remonte que s'il a ÉCRIT quelque chose : un « non » sec ne porte aucune
 * leçon, et un « oui » silencieux est le cas normal. En tirer un savoir
 * remplirait la mémoire de confirmations sans contenu.
 *
 * Enveloppé : une trouvaille est strictement additive, et la laisser lever
 * ferait échouer une résolution d'inbox déjà committée.
 */
async function apprendreDuPlanTranche(
  deps: InboxRoutesDeps,
  item: InboxItemRow,
  log: FastifyBaseLogger,
): Promise<void> {
  if (item.type !== 'approval' || item.subtype !== OPS_INBOX_SUBTYPE) return
  if (!item.projectId) return

  try {
    const projet = await deps.db
      .selectFrom('projects')
      .select('stack')
      .where('id', '=', item.projectId)
      .executeTakeFirst()
    if (!projet?.stack) return

    await apprendreDuRetour(
      { db: deps.db, projectId: item.projectId, stack: projet.stack, runId: item.runId },
      item,
    )
  } catch (err) {
    log.error({ err, itemId: item.id }, 'apprentissage du plan tranché échoué')
  }
}

/**
 * Suite serveur d'une étape de recette approuvée : elle rejoint la recette de
 * la stack, et s'exécutera d'office sur les prochains serveurs vierges.
 *
 * C'est le SEUL chemin par lequel ce qui s'exécute automatiquement s'élargit,
 * et il passe par une décision humaine explicite. Le savoir s'accumule tout
 * seul (`ops/apprendre.ts`) ; le pouvoir, non.
 *
 * Même traitement d'erreur que l'archivage d'un savoir : l'item est déjà
 * résolu, le rejouer est impossible, donc l'échec lève une alerte au lieu de
 * disparaître dans un log.
 */
async function ajouterEtapeOuAlerter(
  deps: InboxRoutesDeps,
  item: InboxItemRow,
  log: FastifyBaseLogger,
): Promise<boolean> {
  try {
    return (await ajouterEtapeApprouvee(deps.db, item)) !== null
  } catch (err) {
    log.error({ err, itemId: item.id }, 'ajout d’étape à la recette échoué')
    await createInboxItem(deps.db, {
      type: 'alert',
      projectId: item.projectId,
      runId: item.runId,
      fromRole: 'system',
      title: `Recette non modifiée · ${item.title}`,
      payload: {
        cause: 'l’étape validée n’a pas pu rejoindre la recette',
        sourceItemId: item.id,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return false
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
      const emailSent = await sendApprovedEmailOrAlert(deps, result.item, req.log)
      const savoirArchived = await archiveSavoirOrAlert(deps, result.item, req.log)
      const emailDraftQueued = await enqueueClientEmailDraft(deps, result.item, req.log)
      const opsApplyQueued = await enqueueOpsApply(deps, result.item, req.log)
      await apprendreDuPlanTranche(deps, result.item, req.log)
      const etapeAjoutee = await ajouterEtapeOuAlerter(deps, result.item, req.log)
      return {
        item: toApiItem(result.item, slug),
        runResumed: result.runResumed,
        emailSent,
        savoirArchived,
        emailDraftQueued,
        opsApplyQueued,
        etapeAjoutee,
      }
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

  /**
   * Fonctionnalité à la demande (BRIEF-RETOUR.md §6 : « la formulation de
   * Florian fait foi ») : propose une version enrichie de `text`, ne l'écrit
   * jamais. Un vrai échange modèle par appel — jamais déclenché à la frappe,
   * seulement quand le panneau question clique « Optimiser ».
   */
  app.post('/api/inbox/:id/optimize', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = optimizeParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'id_invalide' })

    const body = optimizeBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'requete_invalide' })

    const item = await getInboxItem(deps.db, params.data.id)
    if (!item) return reply.code(404).send({ error: 'item_introuvable' })
    // Le panneau question est le seul appelant prévu : un item d'un autre
    // type n'a ni « question posée » ni sens à optimiser une réponse.
    if (item.type !== 'question') return reply.code(400).send({ error: 'type_non_supporte' })
    if (!item.projectId) return reply.code(422).send({ error: 'projet_introuvable' })

    try {
      const result = await optimizeAnswer(deps.db, deps.adapter, deps.settings, {
        projectId: item.projectId,
        question: item.title,
        draft: body.data.text,
      })
      return result
    } catch (err) {
      // `collectStructured` (structured.ts) épuise ses tentatives puis lève
      // une `Error` générique — même traitement que le reste de cette route :
      // 502, jamais un 500 opaque, l'appelant (QuestionPanel) sait que c'est
      // l'échange modèle qui a échoué, pas la route elle-même.
      req.log.error({ err, itemId: item.id }, 'optimisation Hive échouée')
      return reply.code(502).send({ error: 'optimisation_echouee' })
    }
  })
}

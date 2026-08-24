import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from '../../db/types'
import { demanderPlan } from '../../ops/agent'
import { proposerChangement } from '../../ops/change-request'
import { inventaireAcces } from '../../ops/credentials'
import { lireServeur, sonder } from '../../ops/probe'
import type { OpsExecutor, SondeHttp } from '../../ops/types'
import type { RuntimeAdapter } from '../../runtime/types'
import type { SettingsStore } from '../../settings/store'

/**
 * Les serveurs, vus depuis l'écran.
 *
 * ## Ce qui n'est PAS ici, et volontairement
 *
 * Aucune route ne pose un état. On peut enregistrer un serveur et demander une
 * SONDE ; on ne peut pas déclarer qu'un serveur est vierge. Toute la Phase 6
 * repose sur ce point : « vierge » se mesure, et un formulaire qui permettrait
 * de le déclarer contournerait la sonde en un clic.
 *
 * Aucune route n'exécute non plus. `POST /:id/plan` fait travailler l'agent et
 * rend un plan ; sur un serveur en service, le plan part en validation, et
 * c'est la résolution de l'item d'inbox qui déclenche l'exécution.
 */

export interface ServeursRoutesDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  executor: OpsExecutor
  http: SondeHttp
  settings: SettingsStore
}

const idParams = z.object({ id: z.string().uuid() })

const creerBody = z.object({
  /** Sert aussi de préfixe de clé dans le coffre : la forme est contrainte pour ça. */
  nom: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'nom invalide · [a-z0-9-], sans point ni espace'),
  hote: z.string().min(1),
  utilisateur: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  url: z.string().url().optional(),
  notes: z.string().max(2000).optional(),
})

const planBody = z.object({
  projectId: z.string().uuid(),
  besoin: z.string().min(10).max(4000),
})

export async function serveursRoutes(
  app: FastifyInstance,
  deps: ServeursRoutesDeps,
): Promise<void> {
  app.get('/api/serveurs', { preHandler: app.requireAuth }, async () => {
    const rows = await deps.db
      .selectFrom('serveurs')
      .select([
        'id',
        'nom',
        'hote',
        'utilisateur',
        'port',
        'url',
        'etat',
        'etat_mesure_at',
        'notes',
      ])
      .orderBy('nom')
      .execute()

    const acces = await inventaireAcces(deps.db, deps.settings)
    const parNom = new Map(acces.map((a) => [a.serveur, a]))

    return rows.map((r) => ({
      id: r.id,
      nom: r.nom,
      hote: r.hote,
      utilisateur: r.utilisateur,
      port: r.port,
      url: r.url,
      etat: r.etat,
      mesureAt: r.etat_mesure_at ? new Date(r.etat_mesure_at as never).toISOString() : null,
      notes: r.notes,
      // Un booléen, jamais la valeur : même règle que `GET /api/vault`.
      accesDepose: parNom.get(r.nom)?.depose ?? false,
      cleCoffre: parNom.get(r.nom)?.cle ?? null,
    }))
  })

  app.get('/api/serveurs/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const p = idParams.safeParse(req.params)
    if (!p.success) return reply.code(400).send({ error: 'id_invalide' })
    try {
      const s = await lireServeur(deps.db, p.data.id)
      // Les preuves sortent avec l'état : un verdict sans ses preuves ne se
      // conteste pas, et c'est précisément ce verdict qui décide de
      // l'autonomie de l'agent.
      return {
        ...s,
        etatMesureAt: s.etatMesureAt?.toISOString() ?? null,
      }
    } catch {
      return reply.code(404).send({ error: 'serveur_introuvable' })
    }
  })

  app.post('/api/serveurs', { preHandler: app.requireAuth }, async (req, reply) => {
    const b = creerBody.safeParse(req.body)
    if (!b.success) {
      return reply.code(400).send({ error: 'requete_invalide', details: b.error.issues })
    }

    try {
      const row = await deps.db
        .insertInto('serveurs')
        .values({
          nom: b.data.nom,
          hote: b.data.hote,
          utilisateur: b.data.utilisateur,
          ...(b.data.port ? { port: b.data.port } : {}),
          ...(b.data.url ? { url: b.data.url } : {}),
          ...(b.data.notes ? { notes: b.data.notes } : {}),
        })
        .returning(['id', 'nom', 'etat'])
        .executeTakeFirstOrThrow()
      // Neuf donc « inconnu » : aucune autonomie tant qu'on n'a pas mesuré.
      return reply.code(201).send(row)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('serveurs_nom_key')) {
        return reply.code(409).send({ error: 'nom_deja_pris' })
      }
      throw err
    }
  })

  app.post('/api/serveurs/:id/sonde', { preHandler: app.requireAuth }, async (req, reply) => {
    const p = idParams.safeParse(req.params)
    if (!p.success) return reply.code(400).send({ error: 'id_invalide' })

    try {
      const r = await sonder({ db: deps.db, executor: deps.executor, http: deps.http }, p.data.id)
      return r
    } catch (err) {
      req.log.error({ err, id: p.data.id }, 'sonde échouée')
      // La sonde absorbe déjà les échecs de connexion (ils deviennent des
      // preuves « inconnu ») : arriver ici veut dire que le serveur n'existe
      // pas, ou que la base a un problème.
      return reply.code(404).send({ error: 'serveur_introuvable' })
    }
  })

  /**
   * Fait travailler l'agent, et range son plan là où il doit aller.
   *
   * Sur un serveur en service, le plan devient un item d'inbox à valider. Sur
   * un serveur vierge, il est simplement rendu : c'est l'appelant qui décidera
   * de lancer le provisioning, parce qu'un provisioning se déclenche
   * explicitement — pas parce qu'on a demandé un avis.
   */
  app.post('/api/serveurs/:id/plan', { preHandler: app.requireAuth }, async (req, reply) => {
    const p = idParams.safeParse(req.params)
    if (!p.success) return reply.code(400).send({ error: 'id_invalide' })
    const b = planBody.safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'requete_invalide' })

    const serveur = await deps.db
      .selectFrom('serveurs')
      .select('etat')
      .where('id', '=', p.data.id)
      .executeTakeFirst()
    if (!serveur) return reply.code(404).send({ error: 'serveur_introuvable' })
    if (serveur.etat === 'inconnu') {
      // Refus net plutôt qu'une sonde implicite : mesurer est un geste qui
      // touche le serveur, et il doit être demandé.
      return reply.code(409).send({
        error: 'etat_inconnu',
        message: 'sonde ce serveur d’abord · aucune autonomie sans mesure',
      })
    }

    try {
      const resultat = await demanderPlan({
        db: deps.db,
        adapter: deps.adapter,
        executor: deps.executor,
        serveurId: p.data.id,
        projectId: b.data.projectId,
        besoin: b.data.besoin,
      })

      let inboxItemId: string | null = null
      if (resultat.serveur.etat === 'en_service' && resultat.plan.operations.length > 0) {
        const item = await proposerChangement(
          { db: deps.db, serveur: resultat.serveur, projectId: b.data.projectId },
          {
            operations: resultat.plan.operations.map((o) => ({ nom: o.nom, params: o.params })),
            constate: resultat.plan.constate,
            suppose: resultat.plan.suppose,
            motif: b.data.besoin,
          },
        )
        inboxItemId = item.id
      }

      return {
        etat: resultat.serveur.etat,
        plan: resultat.plan,
        recetteAppliquee: resultat.recette !== null,
        inboxItemId,
      }
    } catch (err) {
      req.log.error({ err, id: p.data.id }, 'plan d’exploitation échoué')
      return reply.code(502).send({ error: 'plan_echoue' })
    }
  })
}

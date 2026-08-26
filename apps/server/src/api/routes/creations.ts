import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { tourDeCreation } from '../../creation/conversation'
import { type Fiche, etapeFiche, manquesFiche, retoucheFicheSchema } from '../../creation/fiche'
import {
  type Creation,
  abandonnerCreation,
  corrigerFiche,
  creationEnCours,
  enregistrerTour,
  lireCreation,
  listerCreations,
  ouvrirCreation,
  reprendreCreation,
} from '../../creation/repo'
import type { Database } from '../../db/types'
import type { SondeHttp } from '../../ops/types'
import type { RuntimeAdapter } from '../../runtime/types'

export interface CreationsRoutesDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  cwd: string
  /** La sonde HTTP : vérifier un dépôt ou un staging avant de l'inscrire. */
  http: SondeHttp
}

/**
 * La première réplique, écrite en dur et gratuite.
 *
 * Faire produire « on crée quoi ? » par un modèle coûterait un échange pour
 * une phrase qui ne dépend de rien. La conversation commence quand Florian
 * répond, pas avant.
 */
const OUVERTURE = "On part sur quoi ? Décris-moi le projet, même en une phrase · j'ouvre la scène."

const messageBody = z.object({ texte: z.string().trim().min(1).max(4000) })

/** Ce que l'écran reçoit : la création, plus ce qui s'en dérive. */
function vue(creation: Creation) {
  return {
    ...creation,
    /**
     * L'étape de la scène, calculée côté serveur à partir de la fiche.
     *
     * Dérivée et jamais stockée : une étape persistée pourrait contredire la
     * fiche après une correction manuelle, et l'écran afficherait un fragment
     * découvert dont le contenu vient d'être effacé.
     */
    etape: etapeFiche(creation.fiche),
    manques: manquesFiche(creation.fiche),
  }
}

export async function creationsRoutes(
  app: FastifyInstance,
  deps: CreationsRoutesDeps,
): Promise<void> {
  /**
   * La création en cours, ou `null`.
   *
   * C'est ce que l'écran demande au chargement : un rafraîchissement, ou un
   * onglet rouvert le lendemain, retombe sur la conversation en cours plutôt
   * que d'en ouvrir une vierge à côté.
   */
  app.get('/api/creations/en-cours', { preHandler: app.requireAuth }, async () => {
    const creation = await creationEnCours(deps.db)
    return creation ? vue(creation) : null
  })

  app.post('/api/creations', { preHandler: app.requireAuth }, async (_req, reply) => {
    const creation = await ouvrirCreation(deps.db)
    const avecOuverture = await enregistrerTour(deps.db, creation.id, {
      fiche: creation.fiche,
      conversation: [{ de: 'hive', texte: OUVERTURE, a: new Date().toISOString() }],
    })
    return reply.code(201).send(vue(avecOuverture))
  })

  /**
   * Les conversations passées.
   *
   * Rien ne permettait de relire un cadrage terminé ou abandonné : le fil se
   * déploie tant que la conversation est en cours, puis elle devient
   * inaccessible depuis l'interface. En base, correctement rangée, et lisible
   * par personne d'autre que `psql`.
   *
   * Déclarée AVANT `/:id` : Fastify choisit la route la plus spécifique, mais
   * l'ordre reste la garantie lisible — `en-cours` s'est déjà fait manger par
   * un paramètre ailleurs dans ce fichier.
   */
  app.get('/api/creations/toutes', { preHandler: app.requireAuth }, async () => {
    return listerCreations(deps.db)
  })

  /**
   * Rouvrir une conversation mise de côté. Celle en cours est mise de côté à
   * son tour, jamais détruite : reprendre un ancien cadrage ne doit pas coûter
   * le cadrage en cours.
   */
  app.post('/api/creations/:id/reprendre', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const reprise = await reprendreCreation(deps.db, id)
    if (!reprise) return reply.code(404).send({ error: 'creation_introuvable' })
    return vue(reprise)
  })

  app.get('/api/creations/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const creation = await lireCreation(deps.db, id)
    if (!creation) return reply.code(404).send({ error: 'creation_introuvable' })
    return vue(creation)
  })

  /**
   * Un tour de parole.
   *
   * Rend toujours 200, y compris quand le modèle est tombé : la panne est un
   * tour du fil, pas un code d'erreur HTTP. C'est la règle de Florian —
   * apprendre un échec depuis l'écran où il se produit, jamais en lisant les
   * logs. Un 502 ici afficherait un toast anonyme et perdrait la trace.
   */
  app.post('/api/creations/:id/message', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = messageBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'message_invalide' })

    const creation = await lireCreation(deps.db, id)
    if (!creation) return reply.code(404).send({ error: 'creation_introuvable' })
    if (creation.statut !== 'en_cours') {
      return reply.code(409).send({ error: 'creation_close', statut: creation.statut })
    }

    const { creation: apres, panne } = await tourDeCreation(
      { db: deps.db, adapter: deps.adapter, cwd: deps.cwd, http: deps.http },
      id,
      parsed.data.texte,
    )
    return { ...vue(apres), panne }
  })

  /**
   * Une correction humaine de la fiche.
   *
   * L'échappatoire : quand Hive n'a pas compris le nom, on le tape. N'écrit
   * QUE la fiche — le fil n'est pas réécrit, sinon corriger un dépôt
   * falsifierait ce que Hive a réellement dit.
   */
  app.patch('/api/creations/:id/fiche', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = retoucheFicheSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'fiche_invalide',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    const creation = await lireCreation(deps.db, id)
    if (!creation) return reply.code(404).send({ error: 'creation_introuvable' })

    // Remplacement, pas fusion : l'écran envoie la fiche telle qu'elle est
    // affichée. Fusionner ici rendrait impossible de VIDER un champ que Hive a
    // rempli par erreur, ce qui est précisément l'usage de cette route.
    const apres = await corrigerFiche(deps.db, id, parsed.data as Fiche)
    return vue(apres)
  })

  /**
   * Défaire ce que cette conversation a écrit en base.
   *
   * C'est la contrepartie du fait que Hive crée sans demander de confirmation.
   * Sans ce geste, « il s'occupe de toute la création » voudrait dire « il
   * salit ta base et tu nettoies à la main » — et l'absence de clic de
   * validation deviendrait un piège au lieu d'un confort.
   *
   * Refuse dès qu'un run existe sur le projet : à partir de là, ce n'est plus
   * un brouillon de conversation, c'est du travail. Un `on delete cascade`
   * emporterait les runs, les messages et les artefacts sans le dire.
   */
  app.post('/api/creations/:id/annuler', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const creation = await lireCreation(deps.db, id)
    if (!creation) return reply.code(404).send({ error: 'creation_introuvable' })

    if (creation.projectId) {
      const run = await deps.db
        .selectFrom('runs')
        .innerJoin('steps', 'steps.id', 'runs.step_id')
        .select('runs.id')
        .where('steps.project_id', '=', creation.projectId)
        .executeTakeFirst()
      if (run) {
        return reply.code(409).send({
          error: 'projet_deja_lance',
          detail: 'une boucle a déjà tourné sur ce projet · annuler emporterait son travail',
        })
      }
      await deps.db.deleteFrom('projects').where('id', '=', creation.projectId).execute()
    }

    // L'orbe seulement si elle est restée vide : un autre projet a pu s'y
    // poser entre-temps, et il n'a rien à voir avec cette conversation.
    if (creation.globeId) {
      const autre = await deps.db
        .selectFrom('projects')
        .select('id')
        .where('globe_id', '=', creation.globeId)
        .executeTakeFirst()
      if (!autre) {
        await deps.db.deleteFrom('globes').where('id', '=', creation.globeId).execute()
      }
    }

    await abandonnerCreation(deps.db, id)
    return reply.code(204).send()
  })

  app.post('/api/creations/:id/abandon', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const creation = await lireCreation(deps.db, id)
    if (!creation) return reply.code(404).send({ error: 'creation_introuvable' })
    await abandonnerCreation(deps.db, id)
    return reply.code(204).send()
  })
}

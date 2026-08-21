import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { invoquerCommunicant } from '../../communication/invoke'
import type { Database } from '../../db/types'
import type { GmailDraftPort } from '../../integrations/gmail'
import type { RuntimeAdapter } from '../../runtime/types'

/**
 * Écrire au client, à la demande.
 *
 * Le déclencheur automatique (queue `communicant.draft`, enfilée à la
 * résolution d'une mise en prod) ne couvre qu'un cas : quelque chose est en
 * ligne. Le reste du temps — une relance, un devis à confirmer, une mauvaise
 * nouvelle à annoncer — c'est Florian qui sait qu'il faut écrire, et lui seul.
 * Cette route est là pour ça.
 *
 * Elle ne prend PAS le texte de l'email : elle prend le sujet, en une phrase.
 * Dicter le contenu ferait de Florian le rédacteur et du communicant un
 * correcteur orthographique · l'intérêt est précisément qu'il aille lire la
 * fiche client, en applique le ton, et évite de redemander ce qui a déjà été
 * répondu.
 */

export interface CommunicationRoutesDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  gmailDrafts: GmailDraftPort
}

const params = z.object({ slug: z.string().min(1) })
const body = z.object({
  /**
   * De quoi parler. Une phrase suffit : « relance sur la validation des
   * visuels », « prévenir du décalage de la livraison ».
   */
  sujet: z.string().min(3).max(2000),
})

export async function communicationRoutes(
  app: FastifyInstance,
  deps: CommunicationRoutesDeps,
): Promise<void> {
  app.post(
    '/api/projects/:slug/communicant',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const p = params.safeParse(req.params)
      if (!p.success) return reply.code(400).send({ error: 'slug_invalide' })
      const b = body.safeParse(req.body)
      if (!b.success) return reply.code(400).send({ error: 'requete_invalide' })

      const projet = await deps.db
        .selectFrom('projects')
        .select('id')
        .where('slug', '=', p.data.slug)
        .executeTakeFirst()
      if (!projet) return reply.code(404).send({ error: 'projet_introuvable' })

      try {
        const result = await invoquerCommunicant({
          db: deps.db,
          adapter: deps.adapter,
          drafts: deps.gmailDrafts,
          projectId: projet.id,
          sujet: b.data.sujet,
        })
        // 422 plutôt que 200 avec un corps vide : un projet sans fiche client
        // n'est pas une rédaction réussie qui n'aurait rien produit, c'est une
        // demande qu'on ne peut pas satisfaire — et l'écran doit le dire.
        if (!result.itemId && result.raison?.startsWith('aucune fiche client')) {
          return reply.code(422).send({ error: 'client_absent', raison: result.raison })
        }
        return {
          inboxItemId: result.itemId,
          ...(result.raison ? { raison: result.raison } : {}),
        }
      } catch (err) {
        req.log.error({ err, slug: p.data.slug }, 'rédaction du communicant échouée')
        return reply.code(502).send({ error: 'redaction_echouee' })
      }
    },
  )
}

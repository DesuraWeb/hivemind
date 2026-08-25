import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from '../../db/types'
import { UnknownGlobeError, createProject } from '../../projects/create'
import {
  getProjectBySlug,
  getProjectIdBySlug,
  listProjects,
  listRuns,
  listSteps,
} from '../../projects/repo'
import { listProjectTeam } from '../../projects/team'
import type { SettingsStore } from '../../settings/store'

export interface ProjectsRoutesDeps {
  db: Kysely<Database>
  settings: SettingsStore
}

const params = z.object({ id: z.string().min(1) })

/**
 * Corps de création. Le slug n'y figure pas : il se dérive du nom côté
 * serveur (cf. `projects/create.ts`). Laisser l'appelant le choisir ferait de
 * l'écran de création une API publique, avec ses conflits à gérer.
 */
const createBody = z.object({
  globe: z.string().min(1),
  name: z.string().min(1).max(120),
  repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'attendu : owner/name'),
  clientId: z.string().uuid().optional(),
  stack: z.string().max(120).optional(),
  /**
   * `false` sur un projet sans interface (API, bibliothèque, script) : la
   * boucle traverse `deploying` et `judging` sans ouvrir de navigateur.
   * Absent, c'est `true` — le juge est le seul contrôle qui regarde le
   * résultat plutôt que le code, il ne se désactive pas par distraction.
   */
  jugeVisuel: z.boolean().optional(),
  tint: z.string().max(32).optional(),
  stagingUrl: z.string().max(255).optional(),
  steps: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        specs: z.string().min(1),
        // `auto` ne porte que sur l'itération dev↔reviewer : la mise en prod
        // reste un gate quel que soit ce champ (cf. deploy/prod-gate.ts).
        autonomy: z.enum(['gated', 'auto']).optional(),
        maxIterations: z.number().int().min(1).max(20).optional(),
      }),
    )
    .max(50)
    .optional(),
})

/**
 * Taux de conversion tokens → euros (`settings['pricing.eur_per_mtok']`,
 * seedé à 15 par `seedDefaultSettings`). Si le réglage est absent — base
 * fraîchement migrée sans seed —, on retombe sur la même valeur par défaut
 * plutôt que de planter `GET /api/projects` : c'est un ordre de grandeur
 * d'affichage, jamais une valeur de facturation (cf. seed.ts).
 */
const DEFAULT_EUR_PER_MTOK = 15

async function eurPerMtok(settings: SettingsStore): Promise<number> {
  const value = await settings.get<number>('pricing.eur_per_mtok')
  return typeof value === 'number' ? value : DEFAULT_EUR_PER_MTOK
}

export async function projectsRoutes(
  app: FastifyInstance,
  deps: ProjectsRoutesDeps,
): Promise<void> {
  app.get('/api/projects', { preHandler: app.requireAuth }, async (req) => {
    const rate = await eurPerMtok(deps.settings)
    const all = await listProjects(deps.db, rate)

    // `?globe=<slug>` : l'écran « intérieur de globe » n'affiche que les
    // projets du globe où l'on vient d'entrer. Le filtre est appliqué ici et
    // non côté client parce qu'un globe peut contenir 100+ projets (note du
    // pack DA sur Projets.dc.html) : les envoyer tous pour en jeter la moitié
    // ferait grossir la réponse sans raison. Un slug inconnu rend une liste
    // vide, pas une erreur : c'est la page qui décide quoi en dire.
    const globe = (req.query as { globe?: unknown }).globe
    if (typeof globe === 'string' && globe.length > 0) {
      return all.filter((p) => p.globe === globe)
    }
    return all
  })

  app.post('/api/projects', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) {
      // Les erreurs zod telles quelles : l'écran de création doit pouvoir dire
      // QUEL champ ne va pas, pas seulement que « ça n'a pas marché ».
      return reply.code(400).send({ error: 'requete_invalide', details: parsed.error.issues })
    }

    const { globe, name, repoFullName, clientId, stack, tint, stagingUrl, steps, jugeVisuel } =
      parsed.data
    try {
      // `exactOptionalPropertyTypes` : une clé optionnelle absente doit être
      // absente, jamais présente et valant undefined. Même parade que la route
      // de création de globe.
      const created = await createProject(deps.db, {
        globeSlug: globe,
        name,
        repoFullName,
        ...(clientId !== undefined ? { clientId } : {}),
        ...(stack !== undefined ? { stack } : {}),
        ...(jugeVisuel !== undefined ? { jugeVisuel } : {}),
        ...(tint !== undefined ? { tint } : {}),
        ...(stagingUrl !== undefined ? { stagingUrl } : {}),
        // Normalisé ici plutôt que d'assouplir `CreateStepInput` :
        // `exactOptionalPropertyTypes` refuse une clé présente valant
        // `undefined`, et le type du domaine a raison de l'exiger. C'est la
        // frontière HTTP qui doit s'adapter, pas le domaine.
        ...(steps !== undefined
          ? {
              steps: steps.map((step) => ({
                title: step.title,
                specs: step.specs,
                autonomy: step.autonomy ?? null,
                ...(step.maxIterations !== undefined ? { maxIterations: step.maxIterations } : {}),
              })),
            }
          : {}),
      })
      return reply.code(201).send(created)
    } catch (err) {
      if (err instanceof UnknownGlobeError) {
        return reply.code(404).send({ error: 'globe_introuvable' })
      }
      throw err
    }
  })

  app.get('/api/projects/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = params.safeParse(req.params)
    if (!parsed.success) return reply.code(400).send({ error: 'id_invalide' })

    const rate = await eurPerMtok(deps.settings)
    const project = await getProjectBySlug(deps.db, rate, parsed.data.id)
    if (!project) return reply.code(404).send({ error: 'projet_introuvable' })
    return project
  })

  /**
   * L'équipe du projet. Un rôle non encore matérialisé y figure avec
   * `materialise: false` : c'est ce qui s'appliquera, pas ce qui s'applique
   * (les rôles se matérialisent au premier run qui les résout).
   */
  app.get('/api/projects/:id/roles', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = params.safeParse(req.params)
    if (!parsed.success) return reply.code(400).send({ error: 'id_invalide' })

    const projectId = await getProjectIdBySlug(deps.db, parsed.data.id)
    if (!projectId) return reply.code(404).send({ error: 'projet_introuvable' })
    return listProjectTeam(deps.db, projectId)
  })

  app.get('/api/projects/:id/steps', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = params.safeParse(req.params)
    if (!parsed.success) return reply.code(400).send({ error: 'id_invalide' })

    const projectId = await getProjectIdBySlug(deps.db, parsed.data.id)
    if (!projectId) return reply.code(404).send({ error: 'projet_introuvable' })
    return listSteps(deps.db, projectId)
  })

  app.get('/api/projects/:id/runs', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = params.safeParse(req.params)
    if (!parsed.success) return reply.code(400).send({ error: 'id_invalide' })

    const projectId = await getProjectIdBySlug(deps.db, parsed.data.id)
    if (!projectId) return reply.code(404).send({ error: 'projet_introuvable' })
    return listRuns(deps.db, projectId)
  })

  const patchProjectBody = z.object({
    stack: z.string().max(120).nullable().optional(),
    tint: z.string().max(32).nullable().optional(),
    stagingUrl: z.string().max(255).nullable().optional(),
    /** Mode par défaut des steps qui n'en fixent pas. `auto` ne porte JAMAIS sur la prod. */
    autonomyDefault: z.enum(['gated', 'auto']).optional(),
    /** Voir la création · `false` saute le contrôle visuel sur ce projet. */
    jugeVisuel: z.boolean().optional(),
  })

  /**
   * Onglet « Config » de la fiche projet. Volontairement restreint : ni le
   * nom, ni le slug, ni le dépôt. Le slug est dans toutes les URL et un
   * changement de dépôt invaliderait les worktrees déjà clonés — ce sont des
   * gestes à part entière, pas des champs de formulaire.
   */
  app.patch('/api/projects/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const p = params.safeParse(req.params)
    if (!p.success) return reply.code(400).send({ error: 'id_invalide' })
    const body = patchProjectBody.safeParse(req.body)
    if (!body.success) {
      return reply.code(400).send({ error: 'requete_invalide', details: body.error.issues })
    }

    const projectId = await getProjectIdBySlug(deps.db, p.data.id)
    if (!projectId) return reply.code(404).send({ error: 'projet_introuvable' })

    const { stack, tint, stagingUrl, autonomyDefault, jugeVisuel } = body.data
    const patch = {
      ...(stack !== undefined ? { stack } : {}),
      ...(tint !== undefined ? { tint } : {}),
      ...(stagingUrl !== undefined ? { staging_url: stagingUrl } : {}),
      ...(autonomyDefault !== undefined ? { autonomy_default: autonomyDefault } : {}),
      ...(jugeVisuel !== undefined ? { juge_visuel: jugeVisuel } : {}),
    }
    // Un corps vide n'est pas une erreur, mais ce n'est pas une écriture non
    // plus : `updateTable` sans `set` échouerait côté Kysely.
    if (Object.keys(patch).length === 0) return { updated: false }

    await deps.db.updateTable('projects').set(patch).where('id', '=', projectId).execute()
    return { updated: true }
  })

  const patchStepBody = z.object({
    title: z.string().min(1).max(200).optional(),
    specs: z.string().min(1).optional(),
    autonomy: z.enum(['gated', 'auto']).nullable().optional(),
    maxIterations: z.number().int().min(1).max(20).optional(),
  })

  /**
   * Modifie un step. `autonomy: null` le fait hériter du projet.
   *
   * Refusé sur un step dont un run est en cours : changer le cadrage ou le
   * nombre d'itérations sous les pieds d'une boucle qui tourne produirait un
   * verdict rendu contre des critères qui ont bougé.
   */
  app.patch('/api/steps/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const p = params.safeParse(req.params)
    if (!p.success) return reply.code(400).send({ error: 'id_invalide' })
    const body = patchStepBody.safeParse(req.body)
    if (!body.success) {
      return reply.code(400).send({ error: 'requete_invalide', details: body.error.issues })
    }

    const step = await deps.db
      .selectFrom('steps')
      .select('id')
      .where('id', '=', p.data.id)
      .executeTakeFirst()
    if (!step) return reply.code(404).send({ error: 'step_introuvable' })

    const active = await deps.db
      .selectFrom('runs')
      .select(['id', 'state'])
      .where('step_id', '=', p.data.id)
      .where('ended_at', 'is', null)
      .executeTakeFirst()
    if (active) {
      return reply.code(409).send({ error: 'run_en_cours', runId: active.id, state: active.state })
    }

    const { title, specs, autonomy, maxIterations } = body.data
    const patch = {
      ...(title !== undefined ? { title } : {}),
      ...(specs !== undefined ? { specs } : {}),
      ...(autonomy !== undefined ? { autonomy } : {}),
      ...(maxIterations !== undefined ? { max_iterations: maxIterations } : {}),
    }
    if (Object.keys(patch).length === 0) return { updated: false }

    await deps.db.updateTable('steps').set(patch).where('id', '=', p.data.id).execute()
    return { updated: true }
  })
}

import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from '../../db/types'
import { readRunMessages } from '../../loop/bus'

/**
 * Le détail d'un run : sa timeline de passations, ses artifacts, son coût.
 *
 * C'est la moitié LECTURE de l'écran « Run en direct » (`docs/design/Run en
 * direct.dc.html`) : le pipeline garant → dev → reviewer → juge, le flux
 * d'événements, les compteurs. Le rafraîchissement se fait par le SSE existant
 * (`/api/events`, événement `run.state`), pas par du polling.
 *
 * **La moitié CONTRÔLE n'est pas là** — pas de pause, pas d'arrêt, pas
 * d'injection de consigne. Ce n'est pas un oubli : `decide()` n'a pas
 * d'événement de pause manuelle (`budget_pause` est budgétaire et porte ce
 * sens-là), et en ajouter un touche `domain/run-state.ts`, l'un des trois
 * fichiers de la frontière de sécurité. Ça se fait, mais avec la discipline
 * qui va avec, pas au détour d'une route de lecture.
 */

export interface RunsRoutesDeps {
  db: Kysely<Database>
}

const params = z.object({ id: z.string().uuid() })

export interface RunMessageView {
  id: string
  fromRole: string
  toRole: string
  kind: string
  body: string
  meta: Record<string, unknown>
  at: string
}

export async function runsRoutes(app: FastifyInstance, deps: RunsRoutesDeps): Promise<void> {
  app.get('/api/runs/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = params.safeParse(req.params)
    // `uuid()` et pas `min(1)` : un identifiant mal formé doit être un 400
    // lisible, pas une erreur Postgres remontée en 500.
    if (!parsed.success) return reply.code(400).send({ error: 'id_invalide' })

    const run = await deps.db
      .selectFrom('runs')
      .innerJoin('steps', 'steps.id', 'runs.step_id')
      .innerJoin('projects', 'projects.id', 'steps.project_id')
      .select([
        'runs.id as id',
        'runs.iteration as iteration',
        'runs.state as state',
        'runs.branch as branch',
        'runs.pr_number as prNumber',
        'runs.resume_state as resumeState',
        'runs.review_round as reviewRound',
        'runs.cost_tokens as costTokens',
        'runs.started_at as startedAt',
        'runs.ended_at as endedAt',
        'steps.position as stepPosition',
        'steps.title as stepTitle',
        'steps.max_iterations as maxIterations',
        'projects.slug as projectId',
        'projects.name as projectName',
        // Volontairement PAS `worktree_path` : chemin filesystem du serveur,
        // sans intérêt pour le front et fuite d'infra s'il passait par
        // inadvertance. Même règle que `listRuns`.
      ])
      .where('runs.id', '=', parsed.data.id)
      .executeTakeFirst()

    if (!run) return reply.code(404).send({ error: 'run_introuvable' })

    const messages = await readRunMessages(deps.db, parsed.data.id)
    const artifacts = await deps.db
      .selectFrom('artifacts')
      .select(['id', 'kind', 'path', 'meta', 'created_at as createdAt'])
      .where('run_id', '=', parsed.data.id)
      .orderBy('created_at', 'asc')
      .execute()

    const startedAt = new Date(run.startedAt as unknown as string)
    const endedAt = run.endedAt ? new Date(run.endedAt as unknown as string) : null

    return {
      id: run.id,
      project: { id: run.projectId, name: run.projectName },
      step: { position: run.stepPosition, title: run.stepTitle },
      state: run.state,
      resumeState: run.resumeState,
      iteration: [run.iteration, run.maxIterations] as [number, number],
      reviewRound: run.reviewRound,
      branch: run.branch,
      prNumber: run.prNumber,
      costTokens: Number(run.costTokens),
      startedAt: startedAt.toISOString(),
      endedAt: endedAt?.toISOString() ?? null,
      /**
       * Durée en secondes, calculée côté serveur pour un run terminé. Pour un
       * run en cours on rend `null` plutôt qu'un chrono figé à l'instant de la
       * requête : c'est au front d'animer, à partir de `startedAt`.
       */
      durationSeconds: endedAt
        ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
        : null,
      timeline: messages.map(
        (m): RunMessageView => ({
          id: m.id,
          fromRole: m.fromRole,
          toRole: m.toRole,
          kind: m.kind,
          body: m.body,
          meta: m.meta,
          at: m.createdAt.toISOString(),
        }),
      ),
      artifacts: artifacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        // Chemin relatif à `ARTIFACTS_ROOT`, jamais absolu (décision Phase 4).
        path: a.path,
        meta: a.meta,
        at: new Date(a.createdAt as unknown as string).toISOString(),
      })),
    }
  })
}

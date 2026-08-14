import type { RunState } from '@silithid/shared'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { z } from 'zod'
import type { Database } from '../../db/types'
import type { LoopEvent } from '../../domain/run-state'
import { eventBus } from '../../events/bus'
import { RUN_STEP_QUEUE, type RunStepJobData } from '../../jobs/run-step'
import { readRunMessages } from '../../loop/bus'
import {
  INSTRUCTABLE_ROLES,
  appendHumanInstruction,
  isInstructableRole,
} from '../../loop/instructions'
import { applyEvent } from '../../loop/orchestrator'

/**
 * Le détail d'un run, et les gestes qui permettent de reprendre la main
 * dessus : pause, reprise, arrêt, consigne.
 *
 * La moitié LECTURE (`GET /api/runs/:id`) rend l'écran « Run en direct »
 * (`docs/design/Run en direct.dc.html`) : le pipeline garant → dev → reviewer
 * → juge, le flux d'événements, les compteurs. Le rafraîchissement se fait par
 * le SSE existant (`/api/events`), pas par du polling.
 *
 * La moitié CONTRÔLE comble le manque le plus concret : quand une boucle part
 * de travers, le seul recours était d'attendre `max_iterations`.
 *
 * Trois choix qui ne vont pas de soi, détaillés à leur route respective :
 * `paused_human` est un état distinct de `paused_budget` ; `stopped` est un
 * état terminal distinct de `failed` ; et une consigne n'est PAS lue en temps
 * réel par la session en cours (cf. `loop/instructions.ts`).
 */

export interface RunsRoutesDeps {
  db: Kysely<Database>
  /**
   * Nécessaire à la reprise seule : le worker `run.step` cesse de se
   * ré-enfiler en entrant dans `paused_human` (`NO_REQUEUE_STATES`), donc sans
   * un `boss.send` explicite un run repris repartirait en base sans que
   * personne ne le fasse avancer.
   */
  boss: PgBoss
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

  /** L'identité minimale d'un run, pour distinguer un 404 d'un 409. */
  async function loadRun(runId: string) {
    return deps.db
      .selectFrom('runs')
      .innerJoin('steps', 'steps.id', 'runs.step_id')
      .select(['runs.state as state', 'steps.project_id as projectId'])
      .where('runs.id', '=', runId)
      .executeTakeFirst()
  }

  type ControlOutcome =
    | { ok: true; id: string; state: RunState }
    | { ok: false; code: number; body: Record<string, unknown> }

  /**
   * Le corps commun de pause, reprise et arrêt : valider, appliquer, rendre le
   * nouvel état.
   *
   * Rend un résultat plutôt que d'écrire la réponse, pour que la reprise puisse
   * enchaîner sur un `boss.send` uniquement en cas de succès.
   *
   * Un run introuvable est un 404 ; un événement que la machine à états refuse
   * est un 409 avec sa raison — jamais un 500. `applyEvent` lève sur une
   * décision `invalid` sans avoir rien écrit, donc l'échec est propre : c'est
   * exactement le cas d'une pause demandée sur un run déjà terminé, ou d'une
   * reprise sur un run que le budget a mis en pause entre-temps.
   */
  async function control(rawParams: unknown, event: LoopEvent): Promise<ControlOutcome> {
    const parsed = params.safeParse(rawParams)
    if (!parsed.success) return { ok: false, code: 400, body: { error: 'id_invalide' } }

    const run = await loadRun(parsed.data.id)
    if (!run) return { ok: false, code: 404, body: { error: 'run_introuvable' } }

    try {
      const { state } = await applyEvent(deps.db, parsed.data.id, event)
      return { ok: true, id: parsed.data.id, state }
    } catch (err) {
      return {
        ok: false,
        code: 409,
        body: {
          error: 'transition_refusee',
          state: run.state,
          detail: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  /**
   * Suspend la boucle sur décision humaine.
   *
   * `manual_pause` et non `budget_pause`, malgré la tentation de réutiliser
   * l'existant : `budget_pause` mène à `paused_budget`, et le scheduler de
   * budget (`budget/scheduler.ts`) reprend TOUS les runs dans cet état dès que
   * la jauge repasse sous le seuil de reprise — ce qui est le cas nominal, pas
   * l'exception. Une pause manuelle rangée là serait levée toute seule au tick
   * suivant, cinq minutes plus tard au plus. L'écran afficherait en prime
   * « pause budgétaire » sur une décision humaine.
   */
  app.post('/api/runs/:id/pause', { preHandler: app.requireAuth }, async (req, reply) => {
    const out = await control(req.params, { type: 'manual_pause' })
    if (!out.ok) return reply.code(out.code).send(out.body)
    return { id: out.id, state: out.state }
  })

  /**
   * Relance une boucle mise en pause à la main, à l'étape exacte où elle
   * s'était arrêtée (`runs.resume_state`).
   *
   * Le `boss.send` n'est pas décoratif : sans lui le run repartirait en base
   * sans worker pour le faire avancer, puisque le worker `run.step` a cessé de
   * se ré-enfiler en entrant dans `paused_human`. Envoyé APRÈS le commit
   * d'`applyEvent`, jamais avant — même ordre que `budget/scheduler.ts` et
   * `api/routes/budget.ts`, pour la même raison : un job envoyé sur un run dont
   * la transition serait annulée trouverait un état encore en pause.
   */
  app.post('/api/runs/:id/resume', { preHandler: app.requireAuth }, async (req, reply) => {
    const out = await control(req.params, { type: 'manual_resume' })
    if (!out.ok) return reply.code(out.code).send(out.body)
    await deps.boss.send(RUN_STEP_QUEUE, { runId: out.id } satisfies RunStepJobData)
    return { id: out.id, state: out.state }
  })

  const stopBody = z.object({ reason: z.string().min(1).max(500).optional() })

  /**
   * Arrête définitivement la boucle.
   *
   * Le run finit en `stopped`, PAS en `failed` : un arrêt décidé par un humain
   * n'est pas un échec. Les confondre ferait lire « échec » dans la liste des
   * projets sur une décision volontaire, et rangerait l'arrêt parmi les pannes
   * à diagnostiquer. Côté analytics, `stepsDone` ne compte que les runs `done`
   * (`analytics/repo.ts`) : un arrêt n'y entre donc ni comme réussite ni comme
   * échec, ce qui est la lecture juste.
   *
   * Accepté depuis TOUT état non terminal, y compris `awaiting_human` et les
   * deux pauses : arrêter un run qu'on vient de suspendre pour le regarder est
   * précisément le geste attendu.
   */
  app.post('/api/runs/:id/stop', { preHandler: app.requireAuth }, async (req, reply) => {
    const body = stopBody.safeParse(req.body ?? {})
    if (!body.success) return reply.code(400).send({ error: 'corps_invalide' })

    const out = await control(req.params, {
      type: 'aborted',
      reason: body.data.reason ?? 'arrêt demandé depuis « Run en direct »',
    })
    if (!out.ok) return reply.code(out.code).send(out.body)
    return { id: out.id, state: out.state }
  })

  const instructBody = z.object({
    role: z.string().refine(isInstructableRole, {
      message: `role doit valoir l'un de : ${INSTRUCTABLE_ROLES.join(', ')}`,
    }),
    body: z.string().min(1).max(4000),
  })

  /**
   * Injecte une consigne à destination d'un agent.
   *
   * **Quand elle est lue, sans enjoliver** : les handlers lisent le bus une
   * seule fois, au démarrage de leur invocation, avant d'ouvrir la session de
   * l'agent. Une consigne écrite pendant que le dev travaille n'atteint donc
   * pas la session en cours — elle sera lue au démarrage de la PROCHAINE
   * invocation du handler du rôle visé. Ce n'est pas une injection temps réel.
   * Le geste utile est : pause, consigne, reprise.
   *
   * Seuls `garant` et `dev` sont acceptés : ce sont les deux rôles dont le
   * handler relit réellement le bus (`framing.ts`, `coding.ts`). Accepter
   * `reviewer` ou `judge` ferait avaler une consigne que personne ne lirait
   * jamais — un silence pire qu'un refus.
   *
   * Refusé sur un run terminal : y écrire une consigne serait un message pour
   * un agent qui ne tournera plus.
   */
  app.post('/api/runs/:id/instruct', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = params.safeParse(req.params)
    if (!parsed.success) return reply.code(400).send({ error: 'id_invalide' })

    const body = instructBody.safeParse(req.body ?? {})
    if (!body.success) {
      return reply.code(400).send({ error: 'corps_invalide', detail: body.error.issues })
    }

    const run = await loadRun(parsed.data.id)
    if (!run) return reply.code(404).send({ error: 'run_introuvable' })
    if (run.state === 'done' || run.state === 'failed' || run.state === 'stopped') {
      return reply.code(409).send({ error: 'run_termine', state: run.state })
    }

    await appendHumanInstruction(deps.db, {
      runId: parsed.data.id,
      toRole: body.data.role,
      body: body.data.body,
    })

    // `run.message` et non `run.state` : la timeline a changé, l'état non.
    eventBus.publish({ type: 'run.message', runId: parsed.data.id, projectId: run.projectId })

    return {
      id: parsed.data.id,
      role: body.data.role,
      state: run.state,
      /**
       * Rendu explicitement au front pour qu'il puisse le dire à Florian
       * plutôt que de laisser croire à une prise en compte immédiate.
       */
      readAt: 'prochaine invocation du handler de ce rôle',
    }
  })
}

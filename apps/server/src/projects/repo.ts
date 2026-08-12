import type { InboxType, RunState } from '@silithid/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import {
  type LoopStatus,
  type PendingCount,
  buildLine,
  deriveRole,
  formatConso,
  formatDuree,
  loopFromRunState,
} from './derive'

/**
 * Forme rendue par `GET /api/projects` : les clés suivent `PROJECTS[]` de
 * `docs/design/data.js`. `id` est le `slug` (identifiant public stable), pas
 * l'uuid interne — c'est ce que data.js utilise ("koin", "reparea"…) et ce
 * que les routes `/:id`, `/:id/steps`, `/:id/runs` attendent en paramètre.
 */
export interface ProjectView {
  id: string
  name: string
  client: string | null
  /**
   * Aucune colonne ne porte la stack technique du projet — gap non repéré
   * par l'audit du plan Phase 3 (qui n'en liste que quatre : tint, synth,
   * agent, conso). `null` en attendant une colonne dédiée ; cf. rapport
   * Task 4.
   */
  stack: null
  step: [number, number]
  loop: LoopStatus
  role: string | null
  iteration: [number, number] | null
  duree: string
  tint: string | null
  /**
   * Même situation que `stack` : aucune source de vérité pour la taille du
   * cluster dans l'orbe. `orb.js` (docs/design) traite déjà `p.nodes || 200`
   * comme fallback, donc `null` ne casse pas le rendu prévu par le pack DA.
   */
  nodes: null
  pending: PendingCount[]
  conso: string
  synth: string | null
  staging: string | null
  line: string
}

interface ProjectRow {
  id: string
  slug: string
  name: string
  client_name: string | null
  tint: string | null
  synth: string | null
  staging_url: string | null
}

interface CurrentRun {
  state: RunState
  resumeState: RunState | null
  iteration: number
  startedAt: Date
  stepPosition: number
  maxIterations: number
}

function projectRowQuery(db: Kysely<Database>) {
  return db
    .selectFrom('projects')
    .leftJoin('clients', 'clients.id', 'projects.client_id')
    .select([
      'projects.id as id',
      'projects.slug as slug',
      'projects.name as name',
      'clients.name as client_name',
      'projects.tint as tint',
      'projects.synth as synth',
      'projects.staging_url as staging_url',
    ])
}

/** Run le plus récent (toutes étapes confondues) du projet — c'est lui qui porte le statut affiché. */
async function currentRun(
  db: Kysely<Database>,
  projectId: string,
): Promise<CurrentRun | undefined> {
  const row = await db
    .selectFrom('runs')
    .innerJoin('steps', 'steps.id', 'runs.step_id')
    .select([
      'runs.state as state',
      'runs.resume_state as resumeState',
      'runs.iteration as iteration',
      'runs.started_at as startedAt',
      'steps.position as stepPosition',
      'steps.max_iterations as maxIterations',
    ])
    .where('steps.project_id', '=', projectId)
    .orderBy('runs.started_at', 'desc')
    .orderBy('runs.id', 'desc')
    .executeTakeFirst()

  if (!row) return undefined
  return {
    state: row.state,
    resumeState: row.resumeState,
    iteration: row.iteration,
    startedAt: new Date(row.startedAt as unknown as string),
    stepPosition: row.stepPosition,
    maxIterations: row.maxIterations,
  }
}

async function stepsTotal(db: Kysely<Database>, projectId: string): Promise<number> {
  const row = await db
    .selectFrom('steps')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('project_id', '=', projectId)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

/** Coût cumulé de tous les runs du projet — pas seulement le run courant : `conso` reflète la consommation totale du projet. */
async function tokensTotal(db: Kysely<Database>, projectId: string): Promise<number> {
  const row = await db
    .selectFrom('runs')
    .innerJoin('steps', 'steps.id', 'runs.step_id')
    .select((eb) => eb.fn.sum<string | null>('runs.cost_tokens').as('total'))
    .where('steps.project_id', '=', projectId)
    .executeTakeFirst()
  return Number(row?.total ?? 0)
}

/**
 * Items d'inbox ouverts du projet, groupés par type dans l'ordre de première
 * apparition (le plus ancien `blocked_since` d'abord) — data.js ne documente
 * pas d'ordre de tri formel pour `pending`, celui-ci est déterministe et
 * cohérent avec le tri par défaut de `listInbox` (repo.ts, Task 2).
 */
async function pendingByType(db: Kysely<Database>, projectId: string): Promise<PendingCount[]> {
  const rows = await db
    .selectFrom('inbox_items')
    .select('type')
    .where('project_id', '=', projectId)
    .where('status', '=', 'open')
    .orderBy('blocked_since', 'asc')
    .orderBy('id', 'asc')
    .execute()

  const order: InboxType[] = []
  const counts = new Map<InboxType, number>()
  for (const r of rows) {
    if (!counts.has(r.type)) order.push(r.type)
    counts.set(r.type, (counts.get(r.type) ?? 0) + 1)
  }
  return order.map((type) => ({ type, n: counts.get(type) as number }))
}

async function toProjectView(
  db: Kysely<Database>,
  eurPerMtok: number,
  row: ProjectRow,
  now: Date,
): Promise<ProjectView> {
  const [total, run, tokens, pending] = await Promise.all([
    stepsTotal(db, row.id),
    currentRun(db, row.id),
    tokensTotal(db, row.id),
    pendingByType(db, row.id),
  ])

  const state = run?.state ?? null
  const loop = loopFromRunState(state)
  const role = deriveRole(state, run?.resumeState ?? null)
  // Sans run, on affiche le projet positionné sur la 1ère étape (pas encore
  // démarrée) plutôt que sur la dernière — plus honnête pour un projet neuf.
  const stepCurrent = run ? run.stepPosition : total === 0 ? 0 : 1
  const step: [number, number] = [stepCurrent, total]
  const iteration: [number, number] | null =
    run && (loop === 'run' || loop === 'fail') ? [run.iteration, run.maxIterations] : null
  const duree = formatDuree(loop, run?.startedAt ?? null, now)
  const conso = formatConso(tokens, eurPerMtok)

  return {
    id: row.slug,
    name: row.name,
    client: row.client_name,
    stack: null,
    step,
    loop,
    role,
    iteration,
    duree,
    tint: row.tint,
    nodes: null,
    pending,
    conso,
    synth: row.synth,
    staging: row.staging_url,
    line: buildLine({ step, loop, role, iteration, duree, pending }),
  }
}

export async function listProjects(
  db: Kysely<Database>,
  eurPerMtok: number,
  now: Date = new Date(),
): Promise<ProjectView[]> {
  const rows = await projectRowQuery(db).orderBy('projects.created_at', 'asc').execute()
  return Promise.all(rows.map((row) => toProjectView(db, eurPerMtok, row, now)))
}

export async function getProjectBySlug(
  db: Kysely<Database>,
  eurPerMtok: number,
  slug: string,
  now: Date = new Date(),
): Promise<ProjectView | undefined> {
  const row = await projectRowQuery(db).where('projects.slug', '=', slug).executeTakeFirst()
  if (!row) return undefined
  return toProjectView(db, eurPerMtok, row, now)
}

export async function getProjectIdBySlug(
  db: Kysely<Database>,
  slug: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom('projects')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirst()
  return row?.id
}

export interface StepView {
  id: string
  position: number
  title: string
  specs: string
  autonomy: 'gated' | 'auto' | null
  maxIterations: number
  budgetTokens: number | null
  status: 'pending' | 'running' | 'awaiting_human' | 'validated' | 'failed'
  createdAt: string
}

export async function listSteps(db: Kysely<Database>, projectId: string): Promise<StepView[]> {
  const rows = await db
    .selectFrom('steps')
    .selectAll()
    .where('project_id', '=', projectId)
    .orderBy('position', 'asc')
    .execute()

  return rows.map((r) => ({
    id: r.id,
    position: r.position,
    title: r.title,
    specs: r.specs,
    autonomy: r.autonomy,
    maxIterations: r.max_iterations,
    budgetTokens: r.budget_tokens,
    status: r.status,
    createdAt: new Date(r.created_at as unknown as string).toISOString(),
  }))
}

export interface RunView {
  id: string
  stepId: string
  iteration: number
  state: RunState
  branch: string | null
  prNumber: number | null
  resumeState: RunState | null
  reviewRound: number
  costTokens: number
  startedAt: string
  endedAt: string | null
}

/**
 * Volontairement PAS `worktree_path` : c'est un chemin filesystem local au
 * serveur, sans intérêt pour le front et un risque de fuite d'infra si on le
 * laissait passer par inadvertance (auto-relecture Task 4).
 */
export async function listRuns(db: Kysely<Database>, projectId: string): Promise<RunView[]> {
  const rows = await db
    .selectFrom('runs')
    .innerJoin('steps', 'steps.id', 'runs.step_id')
    .select([
      'runs.id as id',
      'runs.step_id as stepId',
      'runs.iteration as iteration',
      'runs.state as state',
      'runs.branch as branch',
      'runs.pr_number as prNumber',
      'runs.resume_state as resumeState',
      'runs.review_round as reviewRound',
      'runs.cost_tokens as costTokens',
      'runs.started_at as startedAt',
      'runs.ended_at as endedAt',
    ])
    .where('steps.project_id', '=', projectId)
    .orderBy('runs.started_at', 'desc')
    .execute()

  return rows.map((r) => ({
    id: r.id,
    stepId: r.stepId,
    iteration: r.iteration,
    state: r.state,
    branch: r.branch,
    prNumber: r.prNumber,
    resumeState: r.resumeState,
    reviewRound: r.reviewRound,
    costTokens: Number(r.costTokens),
    startedAt: new Date(r.startedAt as unknown as string).toISOString(),
    endedAt: r.endedAt ? new Date(r.endedAt as unknown as string).toISOString() : null,
  }))
}

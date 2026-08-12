import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import type { BusEvent } from '../src/events/bus'
import { eventBus } from '../src/events/bus'
import { getInboxItem } from '../src/inbox/repo'
import { createBoss } from '../src/jobs/boss'
import { RUN_STEP_QUEUE, type StepRegistry, stepOnce } from '../src/jobs/run-step'
import { appendMessage, readRunMessages } from '../src/loop/bus'
import { applyEvent } from '../src/loop/orchestrator'
import { createFakeAdapter } from '../src/runtime/fake'
import { collectStructured, frameSchema } from '../src/runtime/structured'
import type { ToolPolicy } from '../src/runtime/types'

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const boss: PgBoss = createBoss(env)
const app = await buildApp({ db, boss })

let cookie: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await createUser(db, 'florian', 'motdepasse-de-test')
  await boss.start()
  await boss.createQueue(RUN_STEP_QUEUE)
  await app.ready()

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  cookie = login.cookies.find((c) => c.name === 'hm_session')?.value as string
})

afterAll(async () => {
  await app.close()
  await boss.stop()
  await db.destroy()
})

/** globe → client → projet → step → run, prêt en état `framing` (défaut DB). */
async function createFixtureRun(): Promise<{ runId: string; projectId: string }> {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe J6', slug: `globe-j6-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const client = await db
    .insertInto('clients')
    .values({ name: 'Client J6' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      client_id: client.id,
      name: 'Projet J6',
      slug: `projet-j6-${randomUUID()}`,
      repo_full_name: 'silithid/sandbox-j6',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'Step J6', specs: '## Cadrer un step' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { runId: run.id, projectId: project.id }
}

/** Cadrage factice renvoyé par le garant une fois sa question résolue. */
const FAKE_FRAME = {
  dev_prompt:
    'Ajoute un endpoint GET /healthz qui renvoie 200 avec { ok: true }, sans dépendance externe.',
  acceptance_criteria: ['GET /healthz renvoie 200 avec le corps { ok: true }'],
  pages_to_judge: [] as string[],
}

/**
 * Handler factice de l'état `framing` : pose une question bloquante au
 * premier passage (`stepOnce`), puis termine le cadrage au second — celui
 * déclenché par la reprise du run après résolution de l'item. Même patron que
 * `tests/loop-j3.test.ts`, sans le worktree git (hors périmètre du critère
 * J6, qui porte sur la boucle inbox, pas sur git).
 */
function createQuestionThenFrameHandler(): StepRegistry {
  let asked = false
  return {
    framing: async (stepDb, runId) => {
      if (!asked) {
        asked = true
        // Trace la question dans le bus d'audit (`messages`), comme le
        // ferait un vrai handler de rôle (cf. framing.ts) — distinct du bus
        // d'événements SSE (`events/bus.ts`) vérifié plus bas.
        await appendMessage(stepDb, {
          runId,
          fromRole: 'garant',
          toRole: 'system',
          kind: 'question',
          body: 'Le client a-t-il déjà une organisation GitHub existante ?',
        })
        return { type: 'question', blocking: true, fromRole: 'garant' }
      }

      const adapter = createFakeAdapter({
        replies: [{ toolUse: { name: 'submit_frame', input: FAKE_FRAME } }],
      })
      const session = await adapter.createSession({
        roleKey: 'garant',
        systemPrompt: 'Tu es le garant.',
        cwd: process.cwd(),
        tools: { bash: false, fs: 'none', mcp: [] } satisfies ToolPolicy,
        onEvent: () => {},
      })
      const frame = await collectStructured(adapter, session, 'Cadre ce step.', frameSchema, {
        toolName: 'submit_frame',
        toolDescription:
          'Rend le cadrage du step (dev_prompt, acceptance_criteria, pages_to_judge).',
      })
      await appendMessage(stepDb, {
        runId,
        fromRole: 'garant',
        toRole: 'dev',
        kind: 'prompt',
        body: frame.dev_prompt,
        meta: {
          acceptance_criteria: frame.acceptance_criteria,
          pages_to_judge: frame.pages_to_judge,
        },
      })
      return { type: 'frame_ready' }
    },
  }
}

async function pendingRunStepJobs(runId: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from pgboss.job
    where name = ${RUN_STEP_QUEUE} and data->>'runId' = ${runId}
  `.execute(db)
  return Number(rows.rows[0]?.count ?? 0)
}

test('question bloquante -> inbox + SSE -> resolution HTTP -> le run repart (critere J6)', async () => {
  const { runId, projectId } = await createFixtureRun()
  const registry = createQuestionThenFrameHandler()

  // Abonnement RÉEL au bus SSE — on constate ce qui est diffusé, on ne le
  // suppose pas (auto-relecture du plan Phase 3, Task 5).
  const received: BusEvent[] = []
  const unsubscribe = eventBus.subscribe((e) => received.push(e))

  try {
    // 1. La question bloquante fait passer le run en attente humaine.
    const blocked = await stepOnce(db, registry, runId)
    expect(blocked).toEqual({ applied: true, state: 'awaiting_human', requeue: false })

    const runRow = await db
      .selectFrom('runs')
      .select(['state', 'resume_state'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(runRow.state).toBe('awaiting_human')
    expect(runRow.resume_state).toBe('framing')

    const itemRow = await db
      .selectFrom('inbox_items')
      .select('id')
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    const item = await getInboxItem(db, itemRow.id)
    if (!item) throw new Error('item introuvable juste après sa création')
    expect(item.type).toBe('question')
    expect(item.status).toBe('open')
    expect(item.projectId).toBe(projectId)
    expect(item.runId).toBe(runId)
    // L'effet `open_inbox_item` transporte le rôle depuis l'événement : sans
    // lui, l'UI ne pourrait pas distinguer une question du garant d'une
    // question du dev, ce qui est la raison d'être de la colonne (0003).
    expect(item.fromRole).toBe('garant')

    // 2. Diffusion SSE : `run.state` ET `inbox.new` réellement publiés.
    expect(received).toContainEqual({ type: 'run.state', runId, projectId })
    expect(received).toContainEqual({ type: 'inbox.new', id: item.id, projectId })

    // 3. Résolution via l'API HTTP réelle — pas un appel direct à resolveInboxItem.
    const jobsBefore = await pendingRunStepJobs(runId)
    const res = await app.inject({
      method: 'POST',
      url: `/api/inbox/${item.id}/resolve`,
      payload: { response: { text: 'Non, à créer.' } },
      cookies: { hm_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.runResumed).toBe(true)
    expect(body.item).toMatchObject({ id: item.id, status: 'done' })

    const resolvedItem = await getInboxItem(db, item.id)
    expect(resolvedItem?.status).toBe('done')
    expect(resolvedItem?.humanResponse).toEqual({ text: 'Non, à créer.' })
    expect(resolvedItem?.resolvedAt).not.toBeNull()

    expect(received).toContainEqual({ type: 'inbox.resolved', id: item.id, projectId })

    // 4. Le run est reparti depuis `resume_state`, qui est effacé, et le job
    // `run.step` est ré-enfilé — pas seulement l'item marqué `done`.
    const runAfterResolve = await db
      .selectFrom('runs')
      .select(['state', 'resume_state'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(runAfterResolve.state).toBe('framing')
    expect(runAfterResolve.resume_state).toBeNull()
    expect(await pendingRunStepJobs(runId)).toBeGreaterThan(jobsBefore)

    // 5. Preuve que le run avance réellement, pas seulement que l'état a été
    // réécrit : un second passage du worker termine le cadrage.
    const resumed = await stepOnce(db, registry, runId)
    expect(resumed).toEqual({ applied: true, state: 'coding', requeue: true })

    const messages = await readRunMessages(db, runId)
    const question = messages.find((m) => m.kind === 'question' && m.fromRole === 'garant')
    expect(question).toBeDefined()
    const handoff = messages.find(
      (m) => m.kind === 'prompt' && m.fromRole === 'garant' && m.toRole === 'dev',
    )
    expect(handoff?.body).toBe(FAKE_FRAME.dev_prompt)
  } finally {
    unsubscribe()
  }
})

test('une question NON bloquante laisse le run avancer (contraste avec le cas bloquant)', async () => {
  const { runId, projectId } = await createFixtureRun()
  const registry: StepRegistry = {
    framing: async (stepDb, id) => {
      await appendMessage(stepDb, {
        runId: id,
        fromRole: 'garant',
        toRole: 'system',
        kind: 'question',
        body: 'Détail mineur, ne bloque pas la suite.',
      })
      return { type: 'question', blocking: false, fromRole: 'garant' }
    },
  }

  const received: BusEvent[] = []
  const unsubscribe = eventBus.subscribe((e) => received.push(e))
  try {
    const result = await stepOnce(db, registry, runId)
    // Décision `stay` : l'état ne bouge pas, mais reste actif — le worker se
    // ré-enfilerait pour continuer la boucle.
    expect(result).toEqual({ applied: true, state: 'framing', requeue: true })

    const runRow = await db
      .selectFrom('runs')
      .select(['state', 'resume_state'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(runRow.state).toBe('framing')
    expect(runRow.resume_state).toBeNull()

    const itemRow = await db
      .selectFrom('inbox_items')
      .select('id')
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()

    // `inbox.new` diffusé (toute question ouvre un item, brief §7)...
    expect(received).toContainEqual({ type: 'inbox.new', id: itemRow.id, projectId })
    // ... mais PAS `run.state` : une décision `stay` ne change rien que le
    // front doive recharger (cf. orchestrator.ts, applyEvent).
    expect(received.some((e) => e.type === 'run.state' && e.runId === runId)).toBe(false)
  } finally {
    unsubscribe()
  }
})

test("l'item porte le role qui a pose la question, pas null", async () => {
  const { runId, projectId } = await createFixtureRun()
  await applyEvent(db, runId, { type: 'question', blocking: true, fromRole: 'dev' })

  const item = await db
    .selectFrom('inbox_items')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()

  // Sans ce champ, l'UI ne peut pas distinguer une question du garant d'une
  // question du dev : c'est la raison d'être de la colonne (migration 0003).
  expect(item.from_role).toBe('dev')
  expect(projectId).toBeTruthy()
})

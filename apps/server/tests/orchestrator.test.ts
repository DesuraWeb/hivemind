import { randomUUID } from 'node:crypto'
import type { AutonomyMode } from '@silithid/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { readRunMessages } from '../src/loop/bus'
import { applyEvent } from '../src/loop/orchestrator'

const db = createDb(createPool(databaseUrl(loadEnv())))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
afterAll(async () => {
  await db.destroy()
})

interface CreateRunOptions {
  autonomy?: AutonomyMode
  maxIterations?: number
}

/** Un globe + projet + step + run neufs, prêts pour `applyEvent`. */
async function createRun(opts: CreateRunOptions = {}): Promise<string> {
  const globe = await db.selectFrom('globes').select('id').executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'P',
      slug: `p-orch-${randomUUID()}`,
      repo_full_name: 'a/b',
      ...(opts.autonomy ? { autonomy_default: opts.autonomy } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({
      project_id: project.id,
      position: 1,
      title: 'T',
      specs: '## S',
      ...(opts.maxIterations ? { max_iterations: opts.maxIterations } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id })
    .returning('id')
    .executeTakeFirstOrThrow()
  return run.id
}

async function runState(runId: string): Promise<string> {
  const row = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  return row.state
}

test('une transition ecrit l etat ET un message d audit', async () => {
  const runId = await createRun()
  expect(await readRunMessages(db, runId)).toHaveLength(0)

  const { state, decision } = await applyEvent(db, runId, { type: 'frame_ready' })

  expect(state).toBe('coding')
  expect(decision.kind).toBe('transition')
  expect(await runState(runId)).toBe('coding')

  const messages = await readRunMessages(db, runId)
  expect(messages).toHaveLength(1)
  expect(messages[0]?.kind).toBe('info')
  expect(messages[0]?.body).toContain('framing → coding')
})

test('un stay ecrit aussi un message, sans changer l etat', async () => {
  const runId = await createRun()

  const { state, decision } = await applyEvent(db, runId, { type: 'question', blocking: false })

  expect(state).toBe('framing')
  expect(decision.kind).toBe('stay')
  expect(await runState(runId)).toBe('framing')
  expect(await readRunMessages(db, runId)).toHaveLength(1)

  const items = await db.selectFrom('inbox_items').selectAll().where('run_id', '=', runId).execute()
  expect(items).toHaveLength(1)
  expect(items[0]?.type).toBe('question')
})

test('effet increment_iteration incremente reellement runs.iteration, reset_review_round remet a 0', async () => {
  const runId = await createRun({ maxIterations: 4 })
  await db
    .updateTable('runs')
    .set({ state: 'verdict', review_round: 2 })
    .where('id', '=', runId)
    .execute()

  const { state } = await applyEvent(db, runId, { type: 'verdict_ecarts' })
  expect(state).toBe('framing')

  const run = await db
    .selectFrom('runs')
    .select(['iteration', 'review_round'])
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(run.iteration).toBe(2)
  expect(run.review_round).toBe(0)
})

test('effet increment_review_round incremente reellement runs.review_round', async () => {
  const runId = await createRun()
  await db.updateTable('runs').set({ state: 'reviewing' }).where('id', '=', runId).execute()

  await applyEvent(db, runId, { type: 'review_ko' })

  const run = await db
    .selectFrom('runs')
    .select('review_round')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(run.review_round).toBe(1)
})

test('une decision invalid leve et ne laisse aucune trace (atomicite)', async () => {
  const runId = await createRun()
  const messagesBefore = await readRunMessages(db, runId)
  const runBefore = await db
    .selectFrom('runs')
    .selectAll()
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()

  // `framing` n'accepte pas `pr_opened`.
  await expect(applyEvent(db, runId, { type: 'pr_opened', prNumber: 1 })).rejects.toThrow(
    /transition invalide/,
  )

  const messagesAfter = await readRunMessages(db, runId)
  const runAfter = await db
    .selectFrom('runs')
    .selectAll()
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()

  expect(messagesAfter).toHaveLength(messagesBefore.length)
  expect(runAfter).toEqual(runBefore)
})

test('rejouer le meme evenement sur un run deja avance ne double-applique pas', async () => {
  const runId = await createRun()

  await applyEvent(db, runId, { type: 'frame_ready' }) // framing -> coding
  const countAfterFirst = (await readRunMessages(db, runId)).length

  await expect(applyEvent(db, runId, { type: 'frame_ready' })).rejects.toThrow(
    /transition invalide/,
  )

  const countAfterReplay = (await readRunMessages(db, runId)).length
  expect(countAfterReplay).toBe(countAfterFirst)
  expect(await runState(runId)).toBe('coding')
})

test('deux applyEvent concurrents avec le meme evenement : un seul aboutit, jamais de double-application', async () => {
  const runId = await createRun()

  const results = await Promise.allSettled([
    applyEvent(db, runId, { type: 'frame_ready' }),
    applyEvent(db, runId, { type: 'frame_ready' }),
  ])

  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)

  expect(await runState(runId)).toBe('coding')
  expect(await readRunMessages(db, runId)).toHaveLength(1)
})

test('awaiting_human ecrit resume_state ; human_resolved le restaure puis l efface', async () => {
  const runId = await createRun()
  await db.updateTable('runs').set({ state: 'coding' }).where('id', '=', runId).execute()

  const { state } = await applyEvent(db, runId, { type: 'question', blocking: true })
  expect(state).toBe('awaiting_human')

  const paused = await db
    .selectFrom('runs')
    .select('resume_state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(paused.resume_state).toBe('coding')

  const resumed = await applyEvent(db, runId, { type: 'human_resolved' })
  expect(resumed.state).toBe('coding')

  const cleared = await db
    .selectFrom('runs')
    .select('resume_state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(cleared.resume_state).toBeNull()
})

test('paused_budget ecrit resume_state ; budget_resume le restaure puis l efface', async () => {
  const runId = await createRun()
  await db.updateTable('runs').set({ state: 'reviewing' }).where('id', '=', runId).execute()

  await applyEvent(db, runId, { type: 'budget_pause' })
  expect(await runState(runId)).toBe('paused_budget')

  const resumed = await applyEvent(db, runId, { type: 'budget_resume' })
  expect(resumed.state).toBe('reviewing')

  const run = await db
    .selectFrom('runs')
    .select('resume_state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(run.resume_state).toBeNull()
})

test('le gate step_end ne saute jamais hors mode auto (autonomy heritee du projet)', async () => {
  const runId = await createRun({ autonomy: 'gated' })
  await db.updateTable('runs').set({ state: 'verdict' }).where('id', '=', runId).execute()

  const { state } = await applyEvent(db, runId, { type: 'verdict_conforme' })
  expect(state).toBe('awaiting_human')

  const items = await db.selectFrom('inbox_items').selectAll().where('run_id', '=', runId).execute()
  expect(items).toHaveLength(1)
  expect(items[0]?.subtype).toBe('step_end')
})

test('un run introuvable leve une erreur explicite', async () => {
  await expect(
    applyEvent(db, '00000000-0000-0000-0000-000000000000', { type: 'frame_ready' }),
  ).rejects.toThrow(/introuvable/)
})

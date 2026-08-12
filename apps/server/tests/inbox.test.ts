import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import {
  type CreateInboxItemInput,
  createInboxItem,
  getInboxItem,
  listInbox,
} from '../src/inbox/repo'
import { resolveInboxItem } from '../src/inbox/resolve'
import { createBoss } from '../src/jobs/boss'
import { RUN_STEP_QUEUE } from '../src/jobs/run-step'
import { readRunMessages } from '../src/loop/bus'
import { applyEvent } from '../src/loop/orchestrator'

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const boss: PgBoss = createBoss(env)

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await boss.start()
  // Idempotent côté pg-boss (upsert sur le nom de queue, cf. jobs/boss.ts) :
  // sûr même si un autre fichier de test a déjà créé cette queue avant nous.
  await boss.createQueue(RUN_STEP_QUEUE)
})
afterAll(async () => {
  await boss.stop()
  await db.destroy()
})

interface CreateRunOptions {
  state?: 'framing' | 'coding' | 'reviewing'
}

/** Un globe + projet + step + run neufs. Retourne aussi `projectId` pour les tests d'archivage client. */
async function createRun(
  opts: CreateRunOptions = {},
): Promise<{ runId: string; projectId: string }> {
  const globe = await db.selectFrom('globes').select('id').executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'P',
      slug: `p-inbox-${randomUUID()}`,
      repo_full_name: 'a/b',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'T', specs: '## S' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id, ...(opts.state ? { state: opts.state } : {}) })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { runId: run.id, projectId: project.id }
}

/** Crée un client et le rattache au projet donné. */
async function attachClient(projectId: string): Promise<string> {
  const client = await db
    .insertInto('clients')
    .values({ name: 'Client test' })
    .returning('id')
    .executeTakeFirstOrThrow()
  await db
    .updateTable('projects')
    .set({ client_id: client.id })
    .where('id', '=', projectId)
    .execute()
  return client.id
}

async function runRow(runId: string) {
  return db.selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow()
}

/** Jobs pg-boss `run.step` enfilés pour ce run, à date. */
async function pendingRunStepJobs(runId: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from pgboss.job
    where name = ${RUN_STEP_QUEUE} and data->>'runId' = ${runId}
  `.execute(db)
  return Number(rows.rows[0]?.count ?? 0)
}

function makeInput(overrides: Partial<CreateInboxItemInput> = {}): CreateInboxItemInput {
  return { type: 'alert', title: 'Alerte de test', ...overrides }
}

test('un item resolu passe done avec sa reponse et son horodatage', async () => {
  const item = await createInboxItem(db, makeInput({ title: 'Une alerte système' }))

  const before = new Date()
  const result = await resolveInboxItem(db, boss, item.id, { text: 'traité' })
  const after = new Date()

  expect(result.item.status).toBe('done')
  expect(result.item.humanResponse).toEqual({ text: 'traité' })
  expect(result.runResumed).toBe(false)
  expect(result.item.resolvedAt).not.toBeNull()
  expect(result.item.resolvedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
  expect(result.item.resolvedAt?.getTime()).toBeLessThanOrEqual(after.getTime() + 1000)

  const stored = await getInboxItem(db, item.id)
  expect(stored?.status).toBe('done')
})

test('un item bloquant sans run_id (alerte systeme) ne casse pas la resolution', async () => {
  const item = await createInboxItem(db, makeInput({ type: 'alert', title: 'Panne healthcheck' }))
  expect(item.runId).toBeNull()

  const result = await resolveInboxItem(db, boss, item.id, { text: 'ack' })

  expect(result.item.status).toBe('done')
  expect(result.runResumed).toBe(false)
})

test('un item bloquant fait repartir le run depuis resume_state, qui est ensuite efface', async () => {
  const { runId } = await createRun({ state: 'coding' })

  const { state } = await applyEvent(db, runId, {
    type: 'question',
    blocking: true,
    fromRole: 'garant',
  })
  expect(state).toBe('awaiting_human')
  expect((await runRow(runId)).resume_state).toBe('coding')

  const item = await db
    .selectFrom('inbox_items')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(item.status).toBe('open')

  const jobsBefore = await pendingRunStepJobs(runId)
  const result = await resolveInboxItem(db, boss, item.id, { text: 'voici la reponse' })

  expect(result.runResumed).toBe(true)
  expect(result.item.status).toBe('done')

  const run = await runRow(runId)
  expect(run.state).toBe('coding')
  expect(run.resume_state).toBeNull()

  // Le job a bien été ré-enfilé (après le commit, cf. resolve.ts) : c'est ce
  // qui fait réellement « repartir » la boucle, pas seulement l'état en base.
  expect(await pendingRunStepJobs(runId)).toBeGreaterThan(jobsBefore)
})

test('un item non bloquant ne touche pas l etat du run', async () => {
  const { runId } = await createRun()

  await applyEvent(db, runId, { type: 'question', blocking: false, fromRole: 'garant' })
  const item = await db
    .selectFrom('inbox_items')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()

  const before = await runRow(runId)
  expect(before.state).toBe('framing')
  const jobsBefore = await pendingRunStepJobs(runId)

  const result = await resolveInboxItem(db, boss, item.id, { text: 'reponse' })

  expect(result.runResumed).toBe(false)
  const after = await runRow(runId)
  expect(after).toEqual(before)
  expect(await pendingRunStepJobs(runId)).toBe(jobsBefore)
})

test('resoudre deux fois le meme item (en sequence) est refuse', async () => {
  const item = await createInboxItem(db, makeInput())

  await resolveInboxItem(db, boss, item.id, { text: 'premiere reponse' })

  await expect(resolveInboxItem(db, boss, item.id, { text: 'seconde reponse' })).rejects.toThrow(
    /déjà résolu/,
  )
})

test('resoudre deux fois le meme item par une course concurrente : une seule resolution aboutit', async () => {
  const item = await createInboxItem(db, makeInput())

  const results = await Promise.allSettled([
    resolveInboxItem(db, boss, item.id, { text: 'A' }),
    resolveInboxItem(db, boss, item.id, { text: 'B' }),
  ])

  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)

  const stored = await getInboxItem(db, item.id)
  expect(stored?.status).toBe('done')
  // Une seule des deux réponses a été écrite, jamais un mélange des deux.
  expect(['A', 'B']).toContain(stored?.humanResponse?.text)
})

test('atomicite : si la reprise du run echoue, l item reste open (prouve en comptant)', async () => {
  const { runId } = await createRun({ state: 'coding' })
  // Simule un état incohérent (ne devrait jamais arriver via la machine à
  // états normale, cf. run-state.ts) : `awaiting_human` sans `resume_state`.
  // `decide()` refuse alors `human_resolved` — exactement le point de defaillance
  // que cette resolution doit absorber sans rien committer.
  await db
    .updateTable('runs')
    .set({ state: 'awaiting_human', resume_state: null })
    .where('id', '=', runId)
    .execute()

  const item = await createInboxItem(db, makeInput({ type: 'question', runId }))
  const messagesBefore = (await readRunMessages(db, runId)).length
  const jobsBefore = await pendingRunStepJobs(runId)

  await expect(resolveInboxItem(db, boss, item.id, { text: 'reponse' })).rejects.toThrow(
    /reprise du run .* impossible/,
  )

  // Compté, pas supposé : l'item est toujours ouvert, le run est inchangé,
  // aucun message d'audit ni job n'a été écrit — la transaction entière a
  // annulé.
  const storedItem = await getInboxItem(db, item.id)
  expect(storedItem?.status).toBe('open')
  expect(storedItem?.resolvedAt).toBeNull()

  const run = await runRow(runId)
  expect(run.state).toBe('awaiting_human')
  expect(run.resume_state).toBeNull()

  expect(await readRunMessages(db, runId)).toHaveLength(messagesBefore)
  expect(await pendingRunStepJobs(runId)).toBe(jobsBefore)
})

test('archive_to_client:true archive une question vers clients.notes ({q,a,source_item_id,at})', async () => {
  const { runId, projectId } = await createRun()
  const clientId = await attachClient(projectId)

  const item = await createInboxItem(
    db,
    makeInput({ type: 'question', title: 'SIRET du client ?', projectId, runId: null }),
  )
  expect(item.archiveToClient).toBe(true) // défaut DB (migration 0001)

  await resolveInboxItem(db, boss, item.id, { text: '123 456 789 00012' })

  const client = await db
    .selectFrom('clients')
    .select('notes')
    .where('id', '=', clientId)
    .executeTakeFirstOrThrow()
  expect(client.notes).toEqual([
    {
      q: 'SIRET du client ?',
      a: '123 456 789 00012',
      source_item_id: item.id,
      at: expect.any(String),
    },
  ])
})

test('archive_to_client:false n ecrit rien dans clients.notes', async () => {
  const { projectId } = await createRun()
  const clientId = await attachClient(projectId)

  const item = await createInboxItem(
    db,
    makeInput({
      type: 'question',
      title: 'Une question non archivée',
      projectId,
      archiveToClient: false,
    }),
  )

  await resolveInboxItem(db, boss, item.id, { text: 'reponse' })

  const client = await db
    .selectFrom('clients')
    .select('notes')
    .where('id', '=', clientId)
    .executeTakeFirstOrThrow()
  expect(client.notes).toEqual([])
})

test('une approbation (non-question) archivable n ecrit rien dans clients.notes', async () => {
  // Seule une « question » porte un couple {q, a} au sens du brief §7 — une
  // approbation n'a pas de question à archiver, même avec archive_to_client
  // à true (le défaut).
  const { projectId } = await createRun()
  const clientId = await attachClient(projectId)

  const item = await createInboxItem(
    db,
    makeInput({ type: 'approval', subtype: 'prod', title: 'Mise en prod ?', projectId }),
  )

  await resolveInboxItem(db, boss, item.id, { text: 'approuvé' })

  const client = await db
    .selectFrom('clients')
    .select('notes')
    .where('id', '=', clientId)
    .executeTakeFirstOrThrow()
  expect(client.notes).toEqual([])
})

test('listInbox : ouverts d abord, plus anciens en tete, et les filtres marchent', async () => {
  const { projectId: p1 } = await createRun()
  const { projectId: p2 } = await createRun()

  const older = await createInboxItem(db, makeInput({ type: 'question', projectId: p1 }))
  await new Promise((r) => setTimeout(r, 5))
  const newer = await createInboxItem(db, makeInput({ type: 'question', projectId: p1 }))
  const otherProject = await createInboxItem(db, makeInput({ type: 'alert', projectId: p2 }))

  await resolveInboxItem(db, boss, older.id, { text: 'x' })

  const openOnly = await listInbox(db, { status: 'open', projectId: p1 })
  expect(openOnly.map((i) => i.id)).toEqual([newer.id])

  const byType = await listInbox(db, { type: 'alert' })
  expect(byType.map((i) => i.id)).toContain(otherProject.id)
  expect(byType.every((i) => i.type === 'alert')).toBe(true)

  const all = await listInbox(db, { projectId: p1 })
  // `newer` est ouvert donc passe avant `older`, qui est `done`.
  expect(all.map((i) => i.id)).toEqual([newer.id, older.id])
})

test('getInboxItem renvoie undefined pour un id inconnu', async () => {
  expect(await getInboxItem(db, '00000000-0000-0000-0000-000000000000')).toBeUndefined()
})

test('createInboxItem pose les défauts DB attendus (status open, archiveToClient true)', async () => {
  const item = await createInboxItem(db, makeInput({ title: 'Défauts' }))
  expect(item.status).toBe('open')
  expect(item.archiveToClient).toBe(true)
  expect(item.payload).toEqual({})
  expect(item.subtype).toBeNull()
  expect(item.fromRole).toBeNull()
})

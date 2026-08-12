import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { type StepRegistry, stepOnce } from '../src/jobs/run-step'
import { readRunMessages } from '../src/loop/bus'

const db = createDb(createPool(databaseUrl(loadEnv())))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
afterAll(async () => {
  await db.destroy()
})

async function createRun(maxIterations = 4): Promise<string> {
  const globe = await db.selectFrom('globes').select('id').executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'P',
      slug: `p-step-${randomUUID()}`,
      repo_full_name: 'a/b',
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
      max_iterations: maxIterations,
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

test('stepOnce execute le handler de l etat courant, applique l evenement produit, et signale requeue', async () => {
  const runId = await createRun()
  let calls = 0
  const registry: StepRegistry = {
    framing: async () => {
      calls++
      return { type: 'frame_ready' }
    },
  }

  const result = await stepOnce(db, registry, runId)

  expect(calls).toBe(1)
  expect(result).toEqual({ applied: true, state: 'coding', requeue: true })
})

test('stepOnce ne fait rien sur un run deja dans un etat non actif (pas de boucle infinie)', async () => {
  for (const state of ['awaiting_human', 'paused_budget', 'done', 'failed'] as const) {
    const runId = await createRun()
    await db.updateTable('runs').set({ state }).where('id', '=', runId).execute()

    let calls = 0
    const registry: StepRegistry = {
      [state]: async () => {
        calls++
        return { type: 'frame_ready' }
      },
    }

    const result = await stepOnce(db, registry, runId)

    expect(calls, `handler appelé alors que l'état est ${state}`).toBe(0)
    expect(result).toEqual({ applied: false, state, requeue: false })
    expect(await readRunMessages(db, runId)).toHaveLength(0)
  }
})

test('stepOnce signale requeue: false quand le pas atterrit sur un etat non actif (failed)', async () => {
  const runId = await createRun(1)
  await db
    .updateTable('runs')
    .set({ state: 'verdict', iteration: 1 })
    .where('id', '=', runId)
    .execute()
  const registry: StepRegistry = {
    verdict: async () => ({ type: 'verdict_ecarts' }),
  }

  const result = await stepOnce(db, registry, runId)

  expect(result).toEqual({ applied: true, state: 'failed', requeue: false })
})

test('stepOnce leve si aucun executeur n est enregistre pour l etat courant', async () => {
  const runId = await createRun()
  await expect(stepOnce(db, {}, runId)).rejects.toThrow(/aucun exécuteur enregistré/)
  // Rien n'a dû être écrit : l'échec est survenu avant tout appel à applyEvent.
  expect(await readRunMessages(db, runId)).toHaveLength(0)
})

test('un job rejoue apres une transition reussie ne re-execute pas le handler de l etat precedent', async () => {
  const runId = await createRun()
  let framingCalls = 0
  let codingCalls = 0
  const registry: StepRegistry = {
    framing: async () => {
      framingCalls++
      return { type: 'frame_ready' }
    },
    coding: async () => {
      codingCalls++
      return { type: 'pr_opened', prNumber: 1 }
    },
  }

  await stepOnce(db, registry, runId) // framing -> coding
  expect(framingCalls).toBe(1)

  // Le job `run.step` ne transporte que `runId`, jamais l'événement à
  // appliquer : une redelivery pg-boss (ex. crash juste avant l'ack) relit
  // l'état courant et exécute le handler qui lui correspond — jamais celui
  // de l'état déjà quitté.
  await stepOnce(db, registry, runId) // coding -> reviewing
  expect(framingCalls).toBe(1)
  expect(codingCalls).toBe(1)
})

test('deux stepOnce concurrents sur le meme run (double delivery) : un seul aboutit', async () => {
  const runId = await createRun()
  let calls = 0
  const registry: StepRegistry = {
    framing: async () => {
      calls++
      return { type: 'frame_ready' }
    },
  }

  const results = await Promise.allSettled([
    stepOnce(db, registry, runId),
    stepOnce(db, registry, runId),
  ])

  // Le nombre d'appels au handler (1 ou 2) dépend d'une course entre les deux
  // lectures d'état initiales — non déterministe, donc pas asserté. Ce qui
  // compte, et qui doit l'être toujours : l'I/O externe n'est pas protégée
  // par le verrou DB, seule l'écriture d'état l'est (via `applyEvent`), donc
  // un seul `applyEvent` aboutit — jamais les deux.
  expect(calls).toBeGreaterThanOrEqual(1)
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)

  const run = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(run.state).toBe('coding')
  expect(await readRunMessages(db, runId)).toHaveLength(1)
})

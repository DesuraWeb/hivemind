import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedDefaultSettings } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { DEFAULT_GUARDED_PATHS, GUARDED_PATHS_SETTINGS_KEY } from '../src/security/guarded-paths'
import {
  type ChangedFile,
  SELFMOD_INBOX_SUBTYPE,
  loadGuardedPaths,
  runSelfmodGate,
} from '../src/security/selfmod-gate'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts).
const db = createDb(createPool(databaseUrl(loadEnv())))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
beforeEach(async () => {
  await db.deleteFrom('inbox_items').execute()
  await db.deleteFrom('settings').execute()
})
afterAll(async () => {
  await db.destroy()
})

/** Un globe (seedé par la migration 0002) + projet + step + run neufs. */
async function createRun(): Promise<{ runId: string; projectId: string }> {
  const globe = await db.selectFrom('globes').select('id').executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'P',
      slug: `p-selfmod-${randomUUID()}`,
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
    .values({ step_id: step.id })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { runId: run.id, projectId: project.id }
}

function gate(runId: string, projectId: string, files: ChangedFile[], prNumber = 12) {
  return runSelfmodGate(db, {
    runId,
    projectId,
    prNumber,
    prUrl: `https://github.com/a/b/pull/${prNumber}`,
    files,
  })
}

test('la liste par défaut a bien 3 entrées : run-state.ts, tools.ts, roles.ts', () => {
  const paths = DEFAULT_GUARDED_PATHS.map((e) => e.path)
  expect(paths).toContain('apps/server/src/domain/run-state.ts')
  expect(paths).toContain('apps/server/src/runtime/tools.ts')
  expect(paths).toContain('apps/server/src/loop/roles.ts')
  expect(paths).toHaveLength(3)
})

test('loadGuardedPaths retombe sur le défaut si settings est vide', async () => {
  expect(await loadGuardedPaths(db)).toEqual(DEFAULT_GUARDED_PATHS)
})

test('une PR touchant tools.ts (la traduction de ToolPolicy) lève un item distinct', async () => {
  await seedDefaultSettings(db)
  const { runId, projectId } = await createRun()

  const item = await gate(runId, projectId, [
    { path: 'apps/server/src/runtime/tools.ts', status: 'modified' },
    { path: 'README.md', status: 'modified' },
  ])

  expect(item).toBeDefined()
  expect(item?.type).toBe('alert')
  expect(item?.subtype).toBe(SELFMOD_INBOX_SUBTYPE)
  // Distinct d'un approval:step_end ordinaire, dès la forme de l'item.
  expect(item?.type).not.toBe('approval')
  expect(item?.title).toContain('tools.ts')
  expect(item?.title).not.toContain('README.md')

  const payload = item?.payload as { ctx: string; matched_paths: Array<{ path: string }> }
  expect(payload.ctx).toContain('approval:step_end')
  expect(payload.ctx).toMatch(/ne bloque pas le run/)
  expect(payload.matched_paths).toHaveLength(1)
  expect(payload.matched_paths[0]?.path).toBe('apps/server/src/runtime/tools.ts')

  const rows = await db.selectFrom('inbox_items').selectAll().execute()
  expect(rows).toHaveLength(1)
  expect(rows[0]?.run_id).toBe(runId)
  expect(rows[0]?.status).toBe('open')
})

test('une PR ordinaire (aucun chemin surveillé) ne lève rien', async () => {
  await seedDefaultSettings(db)
  const { runId, projectId } = await createRun()

  const item = await gate(runId, projectId, [
    { path: 'apps/web/src/routes/Dashboard.tsx', status: 'modified' },
    { path: 'apps/server/src/loop/steps/coding.ts', status: 'modified' },
  ])

  expect(item).toBeUndefined()
  expect(await db.selectFrom('inbox_items').selectAll().execute()).toHaveLength(0)
})

test('un chemin voisin ne déclenche pas de faux positif', async () => {
  await seedDefaultSettings(db)
  const { runId, projectId } = await createRun()

  const item = await gate(runId, projectId, [
    { path: 'apps/server/src/runtime/tools.test.ts', status: 'modified' },
    { path: 'apps/server/tests/tool-policy.test.ts', status: 'added' },
    { path: 'apps/server/src/runtime/tools/index.ts', status: 'added' },
  ])

  expect(item).toBeUndefined()
})

test('un renommage AWAY d un chemin surveillé déclenche le gate (previousPath)', async () => {
  await seedDefaultSettings(db)
  const { runId, projectId } = await createRun()

  const item = await gate(runId, projectId, [
    {
      path: 'apps/server/src/domain/run-state-v2.ts',
      previousPath: 'apps/server/src/domain/run-state.ts',
      status: 'renamed',
    },
  ])

  expect(item).toBeDefined()
  expect(item?.title).toContain('run-state.ts')
})

test('une suppression d un chemin surveillé déclenche le gate', async () => {
  await seedDefaultSettings(db)
  const { runId, projectId } = await createRun()

  const item = await gate(runId, projectId, [
    { path: 'apps/server/src/runtime/tools.ts', status: 'removed' },
  ])

  expect(item).toBeDefined()
})

test('la colonne roles.tools est couverte via son seul point d ecriture, loop/roles.ts', async () => {
  await seedDefaultSettings(db)
  const { runId, projectId } = await createRun()

  const item = await gate(runId, projectId, [
    { path: 'apps/server/src/loop/roles.ts', status: 'modified' },
  ])

  expect(item).toBeDefined()
  const payload = item?.payload as { matched_paths: Array<{ path: string; reason: string }> }
  expect(payload.matched_paths[0]?.reason).toContain('roles.tools')
})

test('la liste est lue depuis les reglages, pas codee en dur : un reglage personnalisé remplace le défaut', async () => {
  const { runId, projectId } = await createRun()
  await db
    .insertInto('settings')
    .values({
      key: GUARDED_PATHS_SETTINGS_KEY,
      value: JSON.stringify([
        { path: 'apps/server/src/api/routes/roles.ts', reason: "future route d'admin des rôles" },
      ]),
    })
    .execute()

  // Le chemin par défaut (tools.ts) n'est plus dans la liste : plus de match.
  const noMatch = await gate(
    runId,
    projectId,
    [{ path: 'apps/server/src/runtime/tools.ts', status: 'modified' }],
    21,
  )
  expect(noMatch).toBeUndefined()

  // Le chemin ajouté par le réglage, lui, matche — preuve que la liste vient
  // bien de `settings`, pas d'une constante figée dans le code.
  const match = await gate(
    runId,
    projectId,
    [{ path: 'apps/server/src/api/routes/roles.ts', status: 'added' }],
    22,
  )
  expect(match).toBeDefined()
  expect(match?.title).toContain('roles.ts')
})

test('un reglage malforme retombe sur le defaut plutot que de desarmer le gate', async () => {
  const { runId, projectId } = await createRun()
  await db
    .insertInto('settings')
    .values({ key: GUARDED_PATHS_SETTINGS_KEY, value: JSON.stringify(['pas-un-objet']) })
    .execute()

  const item = await gate(runId, projectId, [
    { path: 'apps/server/src/runtime/tools.ts', status: 'modified' },
  ])
  expect(item).toBeDefined()
})

test('pas de doublon tant qu un item ouvert du meme run existe', async () => {
  await seedDefaultSettings(db)
  const { runId, projectId } = await createRun()

  const first = await gate(runId, projectId, [
    { path: 'apps/server/src/runtime/tools.ts', status: 'modified' },
  ])
  const second = await gate(runId, projectId, [
    { path: 'apps/server/src/domain/run-state.ts', status: 'modified' },
  ])

  expect(first).toBeDefined()
  expect(second).toBeUndefined()
  expect(await db.selectFrom('inbox_items').selectAll().execute()).toHaveLength(1)
})

test('un nouvel item est leve une fois le precedent resolu', async () => {
  await seedDefaultSettings(db)
  const { runId, projectId } = await createRun()

  await gate(runId, projectId, [{ path: 'apps/server/src/runtime/tools.ts', status: 'modified' }])
  await db.updateTable('inbox_items').set({ status: 'done' }).execute()

  const second = await gate(runId, projectId, [
    { path: 'apps/server/src/domain/run-state.ts', status: 'modified' },
  ])

  expect(second).toBeDefined()
  expect(await db.selectFrom('inbox_items').selectAll().execute()).toHaveLength(2)
})

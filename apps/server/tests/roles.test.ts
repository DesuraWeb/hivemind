import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { resolveProjectRole } from '../src/loop/roles'
import { ensureGlobe } from './fixtures'

const db = createDb(createPool(databaseUrl(loadEnv())))
let projectId: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await seedRoleTemplates(db)

  const globe = await ensureGlobe(db)
  const project = await db
    .insertInto('projects')
    .values({ globe_id: globe.id, name: 'P', slug: 'p-roles', repo_full_name: 'a/b' })
    .returning('id')
    .executeTakeFirstOrThrow()
  projectId = project.id
})
afterAll(async () => {
  await db.destroy()
})

test('sans ligne roles, materialise depuis role_templates et la persiste', async () => {
  const role = await resolveProjectRole(db, projectId, 'garant')

  expect(role.key).toBe('garant')
  expect(role.systemPrompt.length).toBeGreaterThan(0)

  const row = await db
    .selectFrom('roles')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('key', '=', 'garant')
    .executeTakeFirstOrThrow()
  expect(row.system_prompt).toBe(role.systemPrompt)
  expect(row.template_id).not.toBeNull()
})

test('avec une ligne roles existante, elle fait autorite sur le template', async () => {
  await db
    .updateTable('roles')
    .set({ system_prompt: 'PROMPT EDITE PAR LE PROJET' })
    .where('project_id', '=', projectId)
    .where('key', '=', 'garant')
    .execute()

  const role = await resolveProjectRole(db, projectId, 'garant')
  expect(role.systemPrompt).toBe('PROMPT EDITE PAR LE PROJET')
})

test('deux resolutions concurrentes du meme role ne violent pas la contrainte unique', async () => {
  const [a, b] = await Promise.all([
    resolveProjectRole(db, projectId, 'dev'),
    resolveProjectRole(db, projectId, 'dev'),
  ])

  expect(a.systemPrompt).toBe(b.systemPrompt)

  const rows = await db
    .selectFrom('roles')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('key', '=', 'dev')
    .execute()
  expect(rows).toHaveLength(1)
})

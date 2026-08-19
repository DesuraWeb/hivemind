import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { ensureGlobe } from './fixtures'

const db = createDb(createPool(databaseUrl(loadEnv())))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
afterAll(async () => {
  await db.destroy()
})

test('une installation neuve n a AUCUN globe', async () => {
  // La migration 0002 en créait un, nommé « Desura », pour rattacher les
  // projets existants. La 0006 le retire : le nom d'une agence n'a rien à
  // faire dans le schéma, et l'écran de Création sait poser le premier globe.
  const globes = await db.selectFrom('globes').selectAll().execute()
  expect(globes).toEqual([])
})

test('un projet sans globe_id est refuse', async () => {
  await expect(
    sql`insert into projects (name, slug, repo_full_name) values ('X','x','a/b')`.execute(db),
  ).rejects.toThrow()
})

test('un projet rattache a un globe est accepte', async () => {
  const globe = await ensureGlobe(db)

  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Site vitrine',
      slug: 'site-vitrine',
      repo_full_name: 'exemple/site-vitrine',
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  expect(project.globe_id).toBe(globe.id)
})

test('un run porte resume_state et review_round', async () => {
  const globe = await ensureGlobe(db)
  const project = await db
    .insertInto('projects')
    .values({ globe_id: globe.id, name: 'P', slug: 'p-run', repo_full_name: 'a/b' })
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
    .returningAll()
    .executeTakeFirstOrThrow()

  expect(run.resume_state).toBeNull()
  expect(run.review_round).toBe(0)
})

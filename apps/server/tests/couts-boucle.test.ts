import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { compterPour } from '../src/loop/couts'
import { createProject } from '../src/projects/create'
import { ensureGlobe } from './fixtures'

/**
 * Ce qu'une boucle dépense est enfin compté.
 *
 * ## Le trou
 *
 * `runs.cost_tokens` n'était écrit NULLE PART. L'adaptateur émettait le coût,
 * les cinq handlers passaient tous `onEvent: () => {}` : émis, puis jeté.
 *
 * Le commentaire de tête d'`analytics/repo.ts` affirmait pourtant que « la
 * donnée était déjà là, personne ne la lisait ». Elle n'était pas là.
 * L'écran affichait zéro pour toujours — constaté en production sur un run
 * dont le garant avait produit un cadrage complet.
 *
 * C'est aussi le préalable à toute jauge de budget qui compterait la dépense
 * plutôt que de lire un quota que le SDK ne rend pas.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
let runId: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  const g = await ensureGlobe(db)
  const slug = (
    await db.selectFrom('globes').select('slug').where('id', '=', g.id).executeTakeFirstOrThrow()
  ).slug
  const p = await createProject(db, {
    globeSlug: slug,
    name: 'Compté',
    repoFullName: 'desura/compte',
    steps: [{ title: 'Un', specs: 'a' }],
  })
  const step = await db
    .selectFrom('steps')
    .select('id')
    .where('project_id', '=', p.id)
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id, state: 'framing' })
    .returning('id')
    .executeTakeFirstOrThrow()
  runId = run.id
})

afterAll(async () => {
  await db.destroy()
})

async function cout(): Promise<number> {
  const r = await db
    .selectFrom('runs')
    .select('cost_tokens')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  return Number(r.cost_tokens)
}

test('un run neuf part de zéro', async () => {
  expect(await cout()).toBe(0)
})

test('les échanges s’ADDITIONNENT, ils ne s’écrasent pas', async () => {
  // Un run traverse six états, chacun avec au moins un échange. Écraser au
  // lieu d'additionner ne garderait que le dernier — et le chiffre serait
  // faux sans jamais avoir l'air absent.
  const compter = compterPour(db, runId)
  await compter(1200)
  await compter(800)
  await compter(3000)
  expect(await cout()).toBe(5000)
})

test('deux écritures simultanées ne s’effacent pas l’une l’autre', async () => {
  // Trois boucles avancent en parallèle (`LOOP_CONCURRENCY`). Un compteur lu
  // puis réécrit perdrait une des deux écritures ; `cost_tokens + N` en SQL
  // est atomique.
  const compter = compterPour(db, runId)
  const avant = await cout()
  await Promise.all([compter(100), compter(200), compter(300), compter(400)])
  expect(await cout()).toBe(avant + 1000)
})

test('un coût nul ou aberrant n’écrit rien', async () => {
  // Un adaptateur qui ne sait pas mesurer rend 0. L'écrire ne fait rien de
  // mal, mais rien de bien non plus · et un NaN corromprait la colonne.
  const compter = compterPour(db, runId)
  const avant = await cout()
  await compter(0)
  await compter(-50)
  await compter(Number.NaN)
  expect(await cout()).toBe(avant)
})

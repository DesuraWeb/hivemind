import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { enchainerApres } from '../src/loop/enchainer'
import { startRun } from '../src/loop/start'
import { createProject } from '../src/projects/create'
import { ensureGlobe } from './fixtures'

/**
 * L'enchaînement des steps (demande de Florian).
 *
 * ## Ce qui manquait
 *
 * Un run s'arrêtait quand son step était validé, et rien ne lançait le
 * suivant. Il fallait cliquer « Démarrer la boucle » sur chacun — exactement
 * ce que ce produit existe pour supprimer.
 *
 * ## Ce que ce fichier garde
 *
 * Que l'enchaînement n'ajoute AUCUN pouvoir. Il retire un clic entre deux
 * étapes qui auraient eu lieu de toute façon :
 *
 * - il ne part pas si le projet ne l'a pas demandé ;
 * - il n'avance jamais vers un step qui n'attend pas — donc jamais en
 *   arrière, jamais sur un step déjà validé ou en cours ;
 * - il s'arrête quand il n'y a plus rien.
 *
 * Ce qui l'arrête vraiment n'est pas testé ici parce que ce n'est pas écrit
 * ici : un step `gated` lève une approbation en fin de step, donc le run
 * n'atteint jamais `done` et cette fonction n'est pas appelée. Un step en
 * échec non plus.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
let globeSlug: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  const g = await ensureGlobe(db)
  globeSlug = (
    await db.selectFrom('globes').select('slug').where('id', '=', g.id).executeTakeFirstOrThrow()
  ).slug
})

afterAll(async () => {
  await db.destroy()
})

async function projet(nom: string, enchainement: boolean) {
  const p = await createProject(db, {
    globeSlug,
    name: nom,
    repoFullName: 'desura/essai',
    steps: [
      { title: 'Un', specs: 'a' },
      { title: 'Deux', specs: 'b' },
      { title: 'Trois', specs: 'c' },
    ],
  })
  if (enchainement) {
    await db.updateTable('projects').set({ enchainement: true }).where('id', '=', p.id).execute()
  }
  const steps = await db
    .selectFrom('steps')
    .select(['id', 'position'])
    .where('project_id', '=', p.id)
    .orderBy('position')
    .execute()
  return { projectId: p.id, steps }
}

test('sans demande, rien ne s’enchaîne', async () => {
  const { steps } = await projet('Sans chaîne', false)
  const run = await startRun(db, steps[0]?.id as string)
  // Un enchaînement dépense sans intervention entre les steps. Le rendre
  // implicite ferait partir trois steps là où on en voulait un.
  expect(await enchainerApres(db, run.runId)).toBeNull()
})

test('le step suivant démarre, dans l’ordre', async () => {
  const { steps } = await projet('Avec chaîne', true)
  const run = await startRun(db, steps[0]?.id as string)

  const suite = await enchainerApres(db, run.runId)
  expect(suite?.suivant.position).toBe(2)
  expect(suite?.suivant.title).toBe('Deux')
})

test('la chaîne n’avance jamais vers un step qui n’attend pas', async () => {
  const { projectId, steps } = await projet('Déjà fait', true)
  // Le deuxième est déjà validé : la chaîne doit sauter par-dessus et non
  // le relancer. Elle avance, elle ne repasse jamais derrière.
  await db
    .updateTable('steps')
    .set({ status: 'validated' })
    .where('id', '=', steps[1]?.id as string)
    .execute()

  const run = await startRun(db, steps[0]?.id as string)
  const suite = await enchainerApres(db, run.runId)
  expect(suite?.suivant.position).toBe(3)

  // Et le step validé n'a pas gagné de run au passage.
  const runsDuDeux = await db
    .selectFrom('runs')
    .select('id')
    .where('step_id', '=', steps[1]?.id as string)
    .execute()
  expect(runsDuDeux).toHaveLength(0)
  expect(projectId).toBeTruthy()
})

test('au dernier step, la chaîne s’arrête parce qu’elle est finie', async () => {
  const { steps } = await projet('Fin de chaîne', true)
  const run = await startRun(db, steps[2]?.id as string)
  expect(await enchainerApres(db, run.runId)).toBeNull()
})

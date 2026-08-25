import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import type { DeployTarget } from '../src/deploy/types'
import { databaseUrl, loadEnv } from '../src/env'
import { readRunMessages } from '../src/loop/bus'
import { createDeployingHandler } from '../src/loop/steps/deploying'
import { createJudgingHandler } from '../src/loop/steps/judging'
import { createFakeAdapter } from '../src/runtime/fake'
import { ensureGlobe } from './fixtures'

/**
 * Le juge visuel, désactivable par projet (migration 0014).
 *
 * Ce qui est vérifié n'est pas « la boucle passe » mais **ce qu'elle ne fait
 * pas** : aucun déploiement, aucun navigateur, aucun échange de modèle. Et ce
 * qu'elle dit quand même : un garant qui trancherait sans savoir que personne
 * n'a regardé le rendu conclurait sur du vent.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  await db.deleteFrom('messages').execute()
})

async function creerRun(jugeVisuel: boolean): Promise<string> {
  const globe = await ensureGlobe(db)
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'API sans interface',
      slug: `p-juge-${randomUUID()}`,
      repo_full_name: 'desura/api',
      juge_visuel: jugeVisuel,
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
    .values({ step_id: step.id, state: 'deploying', worktree_path: '/tmp/worktree-inexistant' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return run.id
}

/** Cible qui compte les déploiements. Elle ne doit jamais être appelée. */
function cibleEspionne(): { target: DeployTarget; appels: number[] } {
  const appels: number[] = []
  return {
    appels,
    target: {
      kind: 'espion',
      async deploy() {
        appels.push(1)
        return {
          ok: true,
          url: 'http://127.0.0.1:1',
          description: 'espion',
          release: async () => {},
        }
      },
    },
  }
}

test('juge désactivé · aucun déploiement, aucun navigateur', async () => {
  const runId = await creerRun(false)
  const espion = cibleEspionne()

  const evenement = await createDeployingHandler({
    artifactsRoot: '/tmp/artifacts-inexistant',
    target: espion.target,
  })(db, runId)

  expect(evenement).toEqual({ type: 'ci_green' })
  // Le point : la cible n'a pas été touchée, donc `capturePages` non plus.
  // Sur le VPS c'est ~300 Mo de Chromium qui ne sont pas alloués.
  expect(espion.appels).toHaveLength(0)

  // La timeline dit POURQUOI · un `ci_green` inexpliqué serait pire qu'un échec.
  const messages = await readRunMessages(db, runId)
  expect(messages.at(-1)?.body).toContain('Juge visuel désactivé')
  expect(messages.at(-1)?.meta.juge_visuel).toBe(false)
})

test('juge désactivé · le garant sait que personne n’a regardé', async () => {
  const runId = await creerRun(false)
  // Le faux adaptateur n'est jamais sollicité : s'il l'était, `send` rendrait
  // une réponse en texte libre et `collectStructured` échouerait après trois
  // tentatives. Le test passe donc uniquement si le modèle n'est pas appelé.
  const evenement = await createJudgingHandler({
    adapter: createFakeAdapter(),
    artifactsRoot: '/tmp/x',
  })(db, runId)

  expect(evenement).toEqual({ type: 'judge_report' })

  const rapport = (await readRunMessages(db, runId)).at(-1)
  expect(rapport?.fromRole).toBe('judge')
  expect(rapport?.toRole).toBe('garant')
  // « Rien trouvé » et « pas regardé » ne sont pas la même chose, et le garant
  // tranche différemment selon laquelle des deux il croit.
  expect(rapport?.body).toContain('Aucun contrôle visuel')
  expect(rapport?.body).toContain('ne conclus rien sur le rendu')
  expect(rapport?.meta.ecarts).toEqual([])
})

test('juge activé · le déploiement est bien tenté', async () => {
  const runId = await creerRun(true)
  const espion = cibleEspionne()

  // Le worktree n'existe pas et la capture échouera : ce qui compte est que la
  // cible AIT été appelée · c'est la preuve que le défaut reste « on juge ».
  await createDeployingHandler({
    artifactsRoot: '/tmp/artifacts-inexistant',
    target: espion.target,
  })(db, runId)

  expect(espion.appels).toHaveLength(1)
})

test('un projet neuf a le juge ACTIVÉ · le défaut ne se perd pas', async () => {
  const globe = await ensureGlobe(db)
  const row = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Projet ordinaire',
      slug: `p-defaut-${randomUUID()}`,
      repo_full_name: 'desura/x',
    })
    .returning('juge_visuel')
    .executeTakeFirstOrThrow()

  // Le juge est le seul contrôle qui regarde le RÉSULTAT et non le code. Un
  // défaut à `false` le ferait disparaître par distraction.
  expect(row.juge_visuel).toBe(true)
})

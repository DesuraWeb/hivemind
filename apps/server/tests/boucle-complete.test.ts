import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { type StepRegistry, stepOnce } from '../src/jobs/run-step'
import { ensureGlobe } from './fixtures'

/**
 * La boucle, de bout en bout.
 *
 * ## Le trou que ce fichier bouche
 *
 * Chaque transition de `decide()` est testée isolément (`run-state.test.ts`),
 * chaque handler d'état l'est aussi, et `stepOnce` est testé sur UN pas. Mais
 * rien ne vérifiait que les six états **s'enchaînent** : l'assemblage était
 * affirmé par le README, pas par un test.
 *
 * Trouvé en faisant la vérification fonctionnelle du 25/08, pas par une panne
 * — c'est le genre de trou qui ne se voit que quand on cherche ce qui n'est
 * pas couvert plutôt que ce qui l'est.
 *
 * ## Aucun modèle n'est appelé
 *
 * Le registre est scripté : chaque handler rend l'événement que le vrai
 * produirait, sans agent, sans git, sans navigateur. Ce qui est vérifié ici
 * est le CHAÎNAGE — l'orchestrateur, la machine à états, les effets et le
 * ré-enfilage — pas le travail des agents, qui a ses propres tests.
 */

const db = createDb(createPool(databaseUrl(loadEnv())))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
afterAll(async () => {
  await db.destroy()
})

async function creerRun(opts: { autonomy?: 'gated' | 'auto'; maxIterations?: number } = {}) {
  const globe = await ensureGlobe(db)
  const projet = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Boucle',
      slug: `p-boucle-${randomUUID()}`,
      repo_full_name: 'desura/x',
      autonomy_default: opts.autonomy ?? 'auto',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({
      project_id: projet.id,
      position: 1,
      title: 'T',
      specs: '## S',
      max_iterations: opts.maxIterations ?? 4,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { runId: run.id, stepId: step.id }
}

/**
 * Le registre nominal : chaque état rend ce que le vrai handler produirait
 * quand tout se passe bien. `verdict` est paramétrable — c'est le seul état
 * qui décide de la suite.
 */
function registre(verdict: 'conforme' | 'ecarts' = 'conforme'): StepRegistry {
  return {
    framing: async () => ({ type: 'frame_ready' }),
    coding: async () => ({ type: 'pr_opened', prNumber: 42, prUrl: 'https://x/42' }),
    reviewing: async () => ({ type: 'review_ok' }),
    deploying: async () => ({ type: 'ci_green' }),
    judging: async () => ({ type: 'judge_report' }),
    verdict: async () =>
      verdict === 'conforme' ? { type: 'verdict_conforme' } : { type: 'verdict_ecarts' },
  }
}

/** Fait tourner la boucle jusqu'à ce qu'elle cesse de se ré-enfiler. */
async function derouler(runId: string, reg: StepRegistry, maxPas = 40) {
  const etats: string[] = []
  for (let i = 0; i < maxPas; i++) {
    const r = await stepOnce(db, reg, runId)
    etats.push(r.state)
    if (!r.requeue) return { etats, pas: i + 1 }
  }
  throw new Error(`la boucle ne s'est jamais arrêtée · ${etats.join(' → ')}`)
}

test('un step traverse les six états et se termine · mode auto', async () => {
  const { runId, stepId } = await creerRun({ autonomy: 'auto' })

  const { etats } = await derouler(runId, registre('conforme'))

  // L'ordre exact, et rien d'autre. Un état sauté ou répété se verrait ici.
  expect(etats).toEqual(['coding', 'reviewing', 'deploying', 'judging', 'verdict', 'done'])

  const run = await db
    .selectFrom('runs')
    .select(['state', 'ended_at'])
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(run.state).toBe('done')
  // `end_run` doit avoir été appliqué : un run terminé sans `ended_at` reste
  // « en cours » pour tous les écrans qui le lisent.
  expect(run.ended_at).not.toBeNull()

  const step = await db
    .selectFrom('steps')
    .select('status')
    .where('id', '=', stepId)
    .executeTakeFirstOrThrow()
  // Le défaut que la Phase 5 avait laissé : un step qui restait « en cours »
  // pour toujours parce que rien ne remettait son statut.
  expect(step.status).toBe('validated')
})

test('en mode gated, la boucle S’ARRÊTE et attend un humain', async () => {
  const { runId, stepId } = await creerRun({ autonomy: 'gated' })

  const { etats } = await derouler(runId, registre('conforme'))

  // Le verdict conforme ne termine PAS le run : il lève une approbation.
  // C'est le gate structurel de la DoD §14.
  expect(etats).toEqual([
    'coding',
    'reviewing',
    'deploying',
    'judging',
    'verdict',
    'awaiting_human',
  ])

  const items = await db
    .selectFrom('inbox_items')
    .select(['type', 'subtype'])
    .where('run_id', '=', runId)
    .execute()
  expect(items).toContainEqual({ type: 'approval', subtype: 'step_end' })

  const step = await db
    .selectFrom('steps')
    .select('status')
    .where('id', '=', stepId)
    .executeTakeFirstOrThrow()
  // Surtout PAS `validated` : personne n'a encore validé.
  expect(step.status).not.toBe('validated')
})

test('un verdict en écarts relance une itération complète', async () => {
  const { runId } = await creerRun({ autonomy: 'auto', maxIterations: 2 })

  // Écarts au premier tour, conforme au second.
  let tour = 0
  const reg: StepRegistry = {
    ...registre('conforme'),
    verdict: async () => (++tour === 1 ? { type: 'verdict_ecarts' } : { type: 'verdict_conforme' }),
  }

  const { etats } = await derouler(runId, reg)

  // Le retour en `framing` est ce qui distingue une itération d'un abandon.
  expect(etats).toEqual([
    'coding',
    'reviewing',
    'deploying',
    'judging',
    'verdict',
    'framing',
    'coding',
    'reviewing',
    'deploying',
    'judging',
    'verdict',
    'done',
  ])

  const run = await db
    .selectFrom('runs')
    .select('iteration')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(run.iteration).toBe(2)
})

test('les itérations sont bornées · à la limite, la boucle échoue au lieu de tourner', async () => {
  const { runId, stepId } = await creerRun({ autonomy: 'auto', maxIterations: 2 })

  const { etats, pas } = await derouler(runId, registre('ecarts'))

  expect(etats.at(-1)).toBe('failed')
  // Deux itérations complètes, pas une de plus : sans cette borne, un verdict
  // en écarts systématique boucle jusqu'à épuiser le budget.
  expect(etats.filter((e) => e === 'framing')).toHaveLength(1)
  expect(pas).toBe(12)

  const alertes = await db
    .selectFrom('inbox_items')
    .select('type')
    .where('run_id', '=', runId)
    .where('type', '=', 'alert')
    .execute()
  // Un échec silencieux serait pire que l'échec : personne ne saurait.
  expect(alertes).toHaveLength(1)

  const step = await db
    .selectFrom('steps')
    .select('status')
    .where('id', '=', stepId)
    .executeTakeFirstOrThrow()
  expect(step.status).toBe('failed')
})

test('la boucle dev ↔ reviewer est bornée elle aussi', async () => {
  const { runId } = await creerRun({ autonomy: 'auto' })

  const reg: StepRegistry = {
    ...registre('conforme'),
    reviewing: async () => ({ type: 'review_ko', reason: 'bloquant' }),
  }
  const { etats } = await derouler(runId, reg)

  // Trois allers-retours, puis la main à un humain · jamais une boucle infinie
  // entre deux agents qui ne se mettent pas d'accord.
  expect(etats.at(-1)).toBe('awaiting_human')
  expect(etats.filter((e) => e === 'coding').length).toBeLessThanOrEqual(4)
})

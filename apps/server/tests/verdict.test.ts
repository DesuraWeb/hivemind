import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { appendMessage, readRunMessages } from '../src/loop/bus'
import { createVerdictHandler } from '../src/loop/steps/verdict'
import type { FakeToolCall } from '../src/runtime/fake'
import { createFakeAdapter } from '../src/runtime/fake'
import type { RuntimeAdapter } from '../src/runtime/types'

// Aucun réseau, aucun token : `FakeAdapter` scripte l'appel à l'outil de
// sortie structurée du garant — ce test couvre le câblage (lecture du bus,
// passations écrites) et les deux cas d'arbitrage du plan (Task 4, points 2
// et 3), jamais un vrai jugement du modèle (voir le smoke manuel séparé).

const db = createDb(createPool(databaseUrl(loadEnv())))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await seedRoleTemplates(db)
})
afterAll(async () => {
  await db.destroy()
})

/**
 * globe → projet → step → run, en état `verdict`. `worktree_path` est une
 * chaîne quelconque, jamais un vrai répertoire : `FakeAdapter.createSession`
 * ne touche jamais le disque (voir `src/runtime/fake.ts`), donc rien n'a
 * besoin d'exister réellement pour ce handler sous test.
 */
async function createFixtureRun(
  opts: { iteration?: number; maxIterations?: number } = {},
): Promise<string> {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe Verdict', slug: `globe-verdict-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Projet Verdict',
      slug: `projet-verdict-${randomUUID()}`,
      repo_full_name: 'silithid/sandbox-verdict',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({
      project_id: project.id,
      position: 1,
      title: 'Step verdict',
      specs: '## Trancher',
      max_iterations: opts.maxIterations ?? 4,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({
      step_id: step.id,
      state: 'verdict',
      iteration: opts.iteration ?? 1,
      worktree_path: `/tmp/silithid-verdict-test-${randomUUID()}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return run.id
}

async function seedFrame(runId: string, acceptanceCriteria: string[]): Promise<void> {
  await appendMessage(db, {
    runId,
    fromRole: 'garant',
    toRole: 'dev',
    kind: 'prompt',
    body: 'Cadrage de test pour le verdict — implémente la page comme spécifié.',
    meta: { acceptance_criteria: acceptanceCriteria, pages_to_judge: ['/'] },
  })
}

async function seedReviewerReport(
  runId: string,
  body = 'OK — tests exécutés réellement.',
): Promise<void> {
  await appendMessage(db, {
    runId,
    fromRole: 'reviewer',
    toRole: 'garant',
    kind: 'report',
    body,
    meta: { verdict: 'OK', points: [] },
  })
}

async function seedJudgeReport(
  runId: string,
  opts: { conformites: string[]; ecarts: { severite: string; description: string }[] },
): Promise<void> {
  const lines = [`${opts.conformites.length} conformité(s), ${opts.ecarts.length} écart(s).`]
  if (opts.ecarts.length > 0) {
    lines.push('', 'Écarts :', ...opts.ecarts.map((e) => `- [${e.severite}] ${e.description}`))
  }
  await appendMessage(db, {
    runId,
    fromRole: 'judge',
    toRole: 'garant',
    kind: 'report',
    body: lines.join('\n'),
    meta: { conformites: opts.conformites, ecarts: opts.ecarts },
  })
}

function submitVerdict(input: unknown): FakeToolCall {
  return { toolUse: { name: 'submit_verdict', input } }
}

/** Capture le texte de chaque prompt envoyé à l'adapter, pour vérifier le contenu du préambule sans l'exporter. */
function withPromptCapture(adapter: RuntimeAdapter, captured: string[]): RuntimeAdapter {
  return {
    ...adapter,
    async send(session, message, opts) {
      captured.push(message)
      return adapter.send(session, message, opts)
    },
  }
}

test('verdict conforme sans écart : événement verdict_conforme et passation d’audit', async () => {
  const runId = await createFixtureRun()
  await seedFrame(runId, ['le titre affiche "Bienvenue"'])
  await seedReviewerReport(runId)
  await seedJudgeReport(runId, { conformites: ['le titre est correct'], ecarts: [] })

  const adapter = createFakeAdapter({
    replies: [submitVerdict({ decision: 'conforme', ecarts: [] })],
  })

  const event = await createVerdictHandler({ adapter })(db, runId)
  expect(event).toEqual({ type: 'verdict_conforme' })

  const messages = await readRunMessages(db, runId)
  const audit = messages.find(
    (m) => m.kind === 'report' && m.fromRole === 'garant' && m.toRole === 'system',
  )
  expect(audit).toBeDefined()
  expect(audit?.meta.decision).toBe('conforme')
  expect(audit?.body).toContain('Conforme')
})

test('écart mineur hors critères d’acceptation : le verdict peut être conforme malgré un écart listé', async () => {
  const runId = await createFixtureRun()
  await seedFrame(runId, ['le formulaire refuse un email invalide'])
  await seedReviewerReport(runId)
  await seedJudgeReport(runId, {
    conformites: ['le formulaire refuse bien un email invalide'],
    ecarts: [{ severite: 'mineur', description: 'le bouton est légèrement décalé de 2px' }],
  })

  // Le garant est libre de conserver l'écart mineur dans sa liste tout en
  // décidant "conforme" — c'est exactement le cas du plan : un écart
  // cosmétique hors critère d'acceptation n'empêche pas la conformité.
  const adapter = createFakeAdapter({
    replies: [
      submitVerdict({
        decision: 'conforme',
        ecarts: [
          {
            severite: 'mineur',
            description: 'le bouton est légèrement décalé de 2px, hors critère d’acceptation',
            correctif: 'aucun correctif requis — accepté en l’état',
          },
        ],
      }),
    ],
  })

  const event = await createVerdictHandler({ adapter })(db, runId)
  expect(event).toEqual({ type: 'verdict_conforme' })

  const messages = await readRunMessages(db, runId)
  const audit = messages.find(
    (m) => m.kind === 'report' && m.fromRole === 'garant' && m.toRole === 'system',
  )
  expect(audit?.meta.decision).toBe('conforme')
  expect(audit?.body).toContain('acceptés en l’état')
})

test('verdict écarts : dev_prompt_correctif écrit dans un message correction garant→dev', async () => {
  const runId = await createFixtureRun({ iteration: 1, maxIterations: 4 })
  await seedFrame(runId, ['le formulaire refuse un email invalide'])
  await seedReviewerReport(runId)
  await seedJudgeReport(runId, {
    conformites: [],
    ecarts: [{ severite: 'bloquant', description: 'le formulaire accepte un email invalide' }],
  })

  const correctif =
    'Corrige la validation email côté formulaire : un email sans "@" doit être refusé.'
  const adapter = createFakeAdapter({
    replies: [
      submitVerdict({
        decision: 'ecarts',
        ecarts: [
          {
            severite: 'bloquant',
            description: 'le formulaire accepte un email invalide',
            correctif: 'valider la présence de "@" avant soumission',
          },
        ],
        dev_prompt_correctif: correctif,
      }),
    ],
  })

  const event = await createVerdictHandler({ adapter })(db, runId)
  expect(event).toEqual({ type: 'verdict_ecarts' })

  const messages = await readRunMessages(db, runId)
  const correction = messages.find(
    (m) => m.kind === 'correction' && m.fromRole === 'garant' && m.toRole === 'dev',
  )
  expect(correction).toBeDefined()
  expect(correction?.body).toBe(correctif)

  const audit = messages.find(
    (m) => m.kind === 'report' && m.fromRole === 'garant' && m.toRole === 'system',
  )
  expect(audit?.meta.decision).toBe('ecarts')
})

test('verdict écarts sans dev_prompt_correctif : aucun message correction n’est écrit', async () => {
  // Champ optionnel du contrat figé (`verdictSchema`) : légitime à la
  // dernière itération, quand un écart bloquant persiste mais qu'aucun tour
  // suivant ne lira jamais le correctif (`decide()` bascule vers `failed`).
  const runId = await createFixtureRun({ iteration: 4, maxIterations: 4 })
  await seedFrame(runId, ['critère quelconque'])
  await seedReviewerReport(runId)
  await seedJudgeReport(runId, {
    conformites: [],
    ecarts: [{ severite: 'bloquant', description: 'écart réellement bloquant, non résolu' }],
  })

  const adapter = createFakeAdapter({
    replies: [
      submitVerdict({
        decision: 'ecarts',
        ecarts: [
          {
            severite: 'bloquant',
            description: 'écart réellement bloquant, non résolu',
            correctif: 'nécessite une intervention humaine',
          },
        ],
      }),
    ],
  })

  const event = await createVerdictHandler({ adapter })(db, runId)
  expect(event).toEqual({ type: 'verdict_ecarts' })

  const messages = await readRunMessages(db, runId)
  expect(messages.find((m) => m.kind === 'correction')).toBeUndefined()
})

test('à la dernière itération, le préambule prévient explicitement qu’aucun correctif ne tournera', async () => {
  const runId = await createFixtureRun({ iteration: 3, maxIterations: 3 })
  await seedFrame(runId, ['critère quelconque'])
  await seedReviewerReport(runId)
  await seedJudgeReport(runId, { conformites: ['ok'], ecarts: [] })

  const captured: string[] = []
  const adapter = withPromptCapture(
    createFakeAdapter({ replies: [submitVerdict({ decision: 'conforme', ecarts: [] })] }),
    captured,
  )

  await createVerdictHandler({ adapter })(db, runId)

  expect(captured).toHaveLength(1)
  expect(captured[0]).toContain('iteration = 3')
  expect(captured[0]).toContain('max_iterations = 3')
  expect(captured[0]).toMatch(/DERNIÈRE itération/)
  expect(captured[0]).toContain('dev_prompt_correctif')
})

test('avant la dernière itération, le préambule ne mentionne pas l’arbitrage de fin de boucle', async () => {
  const runId = await createFixtureRun({ iteration: 1, maxIterations: 4 })
  await seedFrame(runId, ['critère quelconque'])
  await seedReviewerReport(runId)
  await seedJudgeReport(runId, { conformites: ['ok'], ecarts: [] })

  const captured: string[] = []
  const adapter = withPromptCapture(
    createFakeAdapter({ replies: [submitVerdict({ decision: 'conforme', ecarts: [] })] }),
    captured,
  )

  await createVerdictHandler({ adapter })(db, runId)

  expect(captured[0]).toContain('iteration = 1')
  expect(captured[0]).toContain('max_iterations = 4')
  expect(captured[0]).not.toMatch(/DERNIÈRE itération/)
})

test('sans cadrage garant→dev dans le bus, le handler échoue explicitement', async () => {
  const runId = await createFixtureRun()
  await seedReviewerReport(runId)
  await seedJudgeReport(runId, { conformites: ['ok'], ecarts: [] })

  const adapter = createFakeAdapter({ replies: [] })
  await expect(createVerdictHandler({ adapter })(db, runId)).rejects.toThrow(/cadrage/)
})

test('sans rapport reviewer→garant dans le bus, le handler échoue explicitement', async () => {
  const runId = await createFixtureRun()
  await seedFrame(runId, ['critère quelconque'])
  await seedJudgeReport(runId, { conformites: ['ok'], ecarts: [] })

  const adapter = createFakeAdapter({ replies: [] })
  await expect(createVerdictHandler({ adapter })(db, runId)).rejects.toThrow(/reviewer/)
})

test('sans rapport juge→garant dans le bus, le handler échoue explicitement', async () => {
  const runId = await createFixtureRun()
  await seedFrame(runId, ['critère quelconque'])
  await seedReviewerReport(runId)

  const adapter = createFakeAdapter({ replies: [] })
  await expect(createVerdictHandler({ adapter })(db, runId)).rejects.toThrow(/juge/)
})

test('sans worktree enregistré, le handler échoue explicitement', async () => {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe Verdict Sans Worktree', slug: `globe-verdict-nowt-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Projet Verdict Sans Worktree',
      slug: `projet-verdict-nowt-${randomUUID()}`,
      repo_full_name: 'silithid/sandbox-verdict-nowt',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'Step sans worktree', specs: '## X' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const runRow = await db
    .insertInto('runs')
    .values({ step_id: step.id, state: 'verdict' })
    .returning('id')
    .executeTakeFirstOrThrow()

  const adapter = createFakeAdapter({ replies: [] })
  await expect(createVerdictHandler({ adapter })(db, runRow.id)).rejects.toThrow(/worktree/)
})

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { recordArtifact } from '../src/artifacts/store'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { readRunMessages } from '../src/loop/bus'
import { createJudgingHandler } from '../src/loop/steps/judging'
import type { FakeToolCall } from '../src/runtime/fake'
import { createFakeAdapter } from '../src/runtime/fake'

// Aucun réseau, aucun token : `FakeAdapter` scripte les appels d'outil du
// juge — ce test couvre la validation `screenshot_ref` et la passation
// juge→garant, jamais un vrai modèle (voir le smoke manuel séparé).

const db = createDb(createPool(databaseUrl(loadEnv())))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await seedRoleTemplates(db)
})
afterAll(async () => {
  await db.destroy()
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

async function tempArtifactsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'silithid-judging-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** globe → client → projet → step → run, juste assez pour un run en état `judging`. */
async function createFixtureRun(): Promise<string> {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe Judging', slug: `globe-judging-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Projet Judging',
      slug: `projet-judging-${randomUUID()}`,
      repo_full_name: 'silithid/sandbox-judging',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'Step judging', specs: '## Juger' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id, state: 'judging' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return run.id
}

/** Passation garant→dev minimale : c'est elle que `judging.ts` lit pour les critères d'acceptation. */
async function seedFrame(runId: string, acceptanceCriteria: string[]): Promise<void> {
  await db
    .insertInto('messages')
    .values({
      run_id: runId,
      from_role: 'garant',
      to_role: 'dev',
      kind: 'prompt',
      body: 'Cadrage de test pour le juge — implémente la page comme spécifié dans les critères ci-dessous.',
      meta: JSON.stringify({ acceptance_criteria: acceptanceCriteria, pages_to_judge: ['/'] }),
    })
    .execute()
}

/** Enregistre une paire (screenshot, dom_snapshot) sur disque + en base, comme le ferait `deploying.ts`. */
async function seedCapture(
  artifactsRoot: string,
  runId: string,
  opts: { page: string; viewport: string; slug: string },
): Promise<{ screenshotRef: string; screenshotId: string }> {
  const dir = join(artifactsRoot, runId)
  await mkdir(dir, { recursive: true })
  const screenshotPath = join(dir, `${opts.slug}-${opts.viewport}.png`)
  const domPath = join(dir, `${opts.slug}-${opts.viewport}.txt`)
  await writeFile(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])) // en-tête PNG minimal, contenu non lu par ce test
  await writeFile(domPath, 'texte du DOM de test', 'utf8')

  const meta = { page: opts.page, viewport: opts.viewport }
  const screenshot = await recordArtifact(db, {
    runId,
    kind: 'screenshot',
    absolutePath: screenshotPath,
    artifactsRoot,
    meta,
  })
  await recordArtifact(db, {
    runId,
    kind: 'dom_snapshot',
    absolutePath: domPath,
    artifactsRoot,
    meta,
  })
  return { screenshotRef: `${opts.slug}-${opts.viewport}.png`, screenshotId: screenshot.id }
}

function submitJudgeReport(input: unknown): FakeToolCall {
  return { toolUse: { name: 'submit_judge_report', input } }
}

test('rapport valide (conformités + écart avec screenshot_ref réel) accepté en un seul essai', async () => {
  const artifactsRoot = await tempArtifactsRoot()
  const runId = await createFixtureRun()
  await seedFrame(runId, ['le titre affiche "Bienvenue"'])
  const { screenshotRef } = await seedCapture(artifactsRoot, runId, {
    page: '/',
    viewport: 'mobile',
    slug: 'index',
  })

  const adapter = createFakeAdapter({
    replies: [
      submitJudgeReport({
        conformites: ['le titre affiche bien "Bienvenue"'],
        ecarts: [
          {
            severite: 'mineur',
            page: '/',
            viewport: 'mobile',
            description: 'le bouton est légèrement décalé',
            screenshot_ref: screenshotRef,
          },
        ],
      }),
    ],
  })

  const handler = createJudgingHandler({ adapter, artifactsRoot })
  const event = await handler(db, runId)

  expect(event).toEqual({ type: 'judge_report' })
})

test('un rapport sans écart (conformités seules) est valide', async () => {
  const artifactsRoot = await tempArtifactsRoot()
  const runId = await createFixtureRun()
  await seedFrame(runId, ['la page se charge sans erreur'])
  await seedCapture(artifactsRoot, runId, { page: '/', viewport: 'desktop', slug: 'index' })

  const adapter = createFakeAdapter({
    replies: [
      submitJudgeReport({
        conformites: ['la page se charge bien sans erreur visible'],
        ecarts: [],
      }),
    ],
  })

  const handler = createJudgingHandler({ adapter, artifactsRoot })
  const event = await handler(db, runId)

  expect(event).toEqual({ type: 'judge_report' })
  const messages = await readRunMessages(db, runId)
  const report = messages.find((m) => m.kind === 'report' && m.fromRole === 'judge')
  expect(report?.meta.ecarts).toEqual([])
  expect(report?.meta.conformites).toEqual(['la page se charge bien sans erreur visible'])
})

test('screenshot_ref inventé au premier essai, corrigé au second : accepté sans erreur', async () => {
  const artifactsRoot = await tempArtifactsRoot()
  const runId = await createFixtureRun()
  await seedFrame(runId, ['le formulaire est visible'])
  const { screenshotRef } = await seedCapture(artifactsRoot, runId, {
    page: '/',
    viewport: 'tablette',
    slug: 'index',
  })

  const adapter = createFakeAdapter({
    replies: [
      submitJudgeReport({
        conformites: [],
        ecarts: [
          {
            severite: 'bloquant',
            page: '/',
            viewport: 'tablette',
            description: 'le formulaire est absent',
            // Référence inventée : ne correspond à aucun artifact enregistré.
            screenshot_ref: 'capture-qui-n-existe-pas.png',
          },
        ],
      }),
      submitJudgeReport({
        conformites: [],
        ecarts: [
          {
            severite: 'bloquant',
            page: '/',
            viewport: 'tablette',
            description: 'le formulaire est absent',
            screenshot_ref: screenshotRef,
          },
        ],
      }),
    ],
  })

  const handler = createJudgingHandler({ adapter, artifactsRoot })
  const event = await handler(db, runId)

  expect(event).toEqual({ type: 'judge_report' })
  const messages = await readRunMessages(db, runId)
  const report = messages.find((m) => m.kind === 'report' && m.fromRole === 'judge')
  expect(
    (report?.meta.ecarts as { screenshot_ref: string }[] | undefined)?.[0]?.screenshot_ref,
  ).toBe(screenshotRef)
})

test('screenshot_ref inventé de façon persistante : rejeté, jamais accepté silencieusement', async () => {
  const artifactsRoot = await tempArtifactsRoot()
  const runId = await createFixtureRun()
  await seedFrame(runId, ['le formulaire est visible'])
  await seedCapture(artifactsRoot, runId, { page: '/', viewport: 'desktop', slug: 'index' })

  const invented = submitJudgeReport({
    conformites: [],
    ecarts: [
      {
        severite: 'bloquant',
        page: '/',
        viewport: 'desktop',
        description: 'le formulaire est absent',
        screenshot_ref: 'toujours-invente.png',
      },
    ],
  })

  // Le juge s'entête : même référence inventée à chaque tentative.
  const adapter = createFakeAdapter({ replies: [invented, invented, invented, invented] })

  const handler = createJudgingHandler({ adapter, artifactsRoot })

  await expect(handler(db, runId)).rejects.toThrow(/screenshot_ref inventé/)

  // Aucune passation juge→garant n'a dû être écrite : un rapport avec une
  // référence morte est inexploitable, il ne doit jamais atteindre le bus.
  const messages = await readRunMessages(db, runId)
  expect(messages.find((m) => m.kind === 'report' && m.fromRole === 'judge')).toBeUndefined()
})

test('la passation juge→garant porte le bon couple de rôles et le bon kind', async () => {
  const artifactsRoot = await tempArtifactsRoot()
  const runId = await createFixtureRun()
  await seedFrame(runId, ['critère quelconque'])
  const { screenshotRef } = await seedCapture(artifactsRoot, runId, {
    page: '/contact',
    viewport: 'mobile',
    slug: 'contact',
  })

  const adapter = createFakeAdapter({
    replies: [
      submitJudgeReport({
        conformites: ['ok'],
        ecarts: [
          {
            severite: 'majeur',
            page: '/contact',
            viewport: 'mobile',
            description: 'espacement incohérent',
            screenshot_ref: screenshotRef,
          },
        ],
      }),
    ],
  })

  const handler = createJudgingHandler({ adapter, artifactsRoot })
  await handler(db, runId)

  const messages = await readRunMessages(db, runId)
  const report = messages.find((m) => m.kind === 'report' && m.fromRole === 'judge')
  expect(report).toBeDefined()
  expect(report?.fromRole).toBe('judge')
  expect(report?.toRole).toBe('garant')
  expect(report?.kind).toBe('report')
  expect(report?.body).toContain('espacement incohérent')
})

test('sans aucune capture enregistrée, le handler échoue explicitement plutôt que de juger à l’aveugle', async () => {
  const artifactsRoot = await tempArtifactsRoot()
  const runId = await createFixtureRun()
  await seedFrame(runId, ['critère quelconque'])

  const adapter = createFakeAdapter({ replies: [] })
  const handler = createJudgingHandler({ adapter, artifactsRoot })

  await expect(handler(db, runId)).rejects.toThrow(/aucune capture/)
})

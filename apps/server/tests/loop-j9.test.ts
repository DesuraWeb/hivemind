/**
 * Critère de fin de Phase 4 (Task 5) : la boucle referme réellement sur
 * elle-même. Un step traverse `framing → coding → reviewing → deploying →
 * judging → verdict`, le juge signale un écart bloquant, le garant rend un
 * correctif, et le SECOND passage par `framing` le lit et produit un cadrage
 * corrigé — pas un cadrage à neuf — jusqu'à ce que le juge (re-scripté
 * conforme) laisse le garant conclure.
 *
 * `deploying.ts`/`judging.ts` tournent pour de vrai (Playwright + serveur
 * statique local, aucun réseau) : seul le modèle est un `FakeAdapter`, aucun
 * token consommé. `coding.ts` est doublé (comme `review-loop.test.ts`,
 * déjà couvert seul par son propre smoke réel) parce qu'il ouvrirait sinon
 * une vraie pull request GitHub — mais écrit un vrai commit, poussé pour de
 * vrai sur le dépôt jetable, exactement comme un dev réel le ferait.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { createLocalPreviewTarget } from '../src/deploy/local-preview'
import { databaseUrl, loadEnv } from '../src/env'
import { projectRepoPath } from '../src/git/repo'
import { closeBrowser } from '../src/integrations/playwright'
import { type StepRegistry, stepOnce } from '../src/jobs/run-step'
import { appendMessage, readRunMessages } from '../src/loop/bus'
import { createDeployingHandler } from '../src/loop/steps/deploying'
import { createFramingHandler } from '../src/loop/steps/framing'
import { createJudgingHandler } from '../src/loop/steps/judging'
import { createReviewingHandler } from '../src/loop/steps/reviewing'
import { createVerdictHandler } from '../src/loop/steps/verdict'
import type { FakeToolCall } from '../src/runtime/fake'
import { createFakeAdapter } from '../src/runtime/fake'
import type { RuntimeAdapter } from '../src/runtime/types'
import { createThrowawayRepo } from '../src/runtime/worktree'

const run = promisify(execFile)
const db = createDb(createPool(databaseUrl(loadEnv())))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await seedRoleTemplates(db)
})
afterAll(async () => {
  // Le navigateur Chromium partagé (`integrations/playwright.ts`) survit à
  // ce fichier tant qu'on ne le ferme pas explicitement, exactement comme en
  // production entre deux runs — voir `capture.test.ts`/`preview.test.ts`.
  await closeBrowser()
  await db.destroy()
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

const DEV_COMMIT_IDENTITY = ['-c', 'user.name=Test Dev', '-c', 'user.email=dev@silithid.invalid']

function pageHtml(round: number): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>Silithid sandbox</title></head>',
    `<body><h1>${round === 1 ? 'Accueil' : 'Silithid'}</h1><p>tour ${round}</p></body></html>`,
  ].join('\n')
}

/**
 * Double de test pour `coding.ts` (Task 10, déjà couvert par son propre
 * smoke réel — pas retesté ici) : produit les mêmes effets observables qu'un
 * vrai tour de dev — un commit réel poussé sur `run/<runId>`, une "PR"
 * fictive numérotée, un rapport dev→garant dans le bus — sans agent réel ni
 * réseau GitHub. Écrit une VRAIE page HTML (contrairement au marqueur texte
 * de `review-loop.test.ts`) : c'est elle que `deploying.ts` sert et que
 * Playwright capture réellement.
 */
function createFakeCodingHandler(): NonNullable<StepRegistry['coding']> {
  let round = 0
  return async (stepDb, runId) => {
    round++
    const runRow = await stepDb
      .selectFrom('runs')
      .select(['branch', 'worktree_path', 'pr_number'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    const branch = runRow.branch ?? `run/${runId}`
    const worktreePath = runRow.worktree_path
    if (!worktreePath) throw new Error('worktree du dev introuvable (fake coding handler)')

    await writeFile(join(worktreePath, 'index.html'), pageHtml(round))
    await run('git', ['add', 'index.html'], { cwd: worktreePath })
    await run('git', [...DEV_COMMIT_IDENTITY, 'commit', '-m', `feat: tour ${round}`], {
      cwd: worktreePath,
    })
    await run('git', ['push', '-u', 'origin', `HEAD:${branch}`], { cwd: worktreePath })

    const prNumber = runRow.pr_number ?? 1
    await stepDb
      .updateTable('runs')
      .set({ branch, pr_number: prNumber, worktree_path: worktreePath })
      .where('id', '=', runId)
      .execute()

    await appendMessage(stepDb, {
      runId,
      fromRole: 'dev',
      toRole: 'garant',
      kind: 'report',
      body: `Tour ${round} : page publiée (rapport du dev).`,
      meta: { pr_number: prNumber, pr_url: `https://example.invalid/pull/${prNumber}`, branch },
    })
    return { type: 'pr_opened', prNumber }
  }
}

function submitFrame(input: unknown): FakeToolCall {
  return { toolUse: { name: 'submit_frame', input } }
}
function submitReview(input: unknown): FakeToolCall {
  return { toolUse: { name: 'submit_review', input } }
}
function submitJudgeReport(input: unknown): FakeToolCall {
  return { toolUse: { name: 'submit_judge_report', input } }
}
function submitVerdict(input: unknown): FakeToolCall {
  return { toolUse: { name: 'submit_verdict', input } }
}

function fakeKoReview(round: number): FakeToolCall {
  return submitReview({
    verdict: 'KO',
    points: [{ file: 'index.html', action: `corrige le titre (tour ${round})` }],
  })
}
const reviewOk = submitReview({ verdict: 'OK', points: [] })

const FRAME_1 = {
  dev_prompt:
    'Publie une page d’accueil minimale avec un titre "Silithid" bien visible en <h1>, ' +
    'sans dépendance externe, dans le style du dépôt sandbox.',
  acceptance_criteria: ['Le titre "Silithid" est visible en <h1> sur la page d’accueil.'],
  pages_to_judge: ['/'],
}
const CORRECTIF =
  'Le titre affiché est "Accueil", pas "Silithid" — remplace le contenu du <h1> par ' +
  'exactement "Silithid", rien d’autre ne change.'
const FRAME_2 = {
  dev_prompt: `CORRECTIF (itération 2) : ${CORRECTIF} Garde le reste de la page minimale à l’identique.`,
  acceptance_criteria: ['Le titre "Silithid" est visible en <h1> sur la page d’accueil.'],
  pages_to_judge: ['/'],
}

async function createFixtureProject(opts: {
  worktreesRoot: string
  sourceRepoPath: string
  maxIterations: number
}): Promise<{ projectId: string; stepId: string; runId: string; repoPath: string }> {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe J9', slug: `globe-j9-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const client = await db
    .insertInto('clients')
    .values({ name: 'Client J9' })
    .returning('id')
    .executeTakeFirstOrThrow()

  const projectSlug = `projet-j9-${randomUUID()}`

  // Même patron que `review-loop.test.ts` : le clone pré-existe exactement
  // là où `ensureProjectRepo` le cherche (décision C), `origin` pointe vers
  // le dépôt jetable local — aucun accès réseau dans ce test.
  const repoPath = projectRepoPath(opts.worktreesRoot, projectSlug)
  await mkdir(dirname(repoPath), { recursive: true })
  await run('git', ['clone', opts.sourceRepoPath, repoPath])

  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      client_id: client.id,
      name: 'Projet J9',
      slug: projectSlug,
      repo_full_name: 'silithid/sandbox-j9',
      default_branch: 'main',
      // `auto` : un `verdict_conforme` boucle direct sur `done`, sans gate
      // humain supplémentaire — hors périmètre de ce test (couvert par
      // `verdict.test.ts`/`run-state.test.ts`), qui porte sur l'itération.
      autonomy_default: 'auto',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const step = await db
    .insertInto('steps')
    .values({
      project_id: project.id,
      position: 1,
      title: 'Step J9',
      specs: '## Cadrer, coder, revoir, déployer, juger, trancher',
      max_iterations: opts.maxIterations,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const startedRun = await db
    .insertInto('runs')
    .values({ step_id: step.id })
    .returning('id')
    .executeTakeFirstOrThrow()

  return { projectId: project.id, stepId: step.id, runId: startedRun.id, repoPath }
}

test(
  'boucle complète : écart bloquant puis conformité — itération, review_round, correctif, timeline (critère de fin Phase 4)',
  { timeout: 60_000 },
  async () => {
    const sourceRepo = await createThrowawayRepo()
    cleanups.push(sourceRepo.dispose)
    const worktreesRoot = await mkdtemp(join(tmpdir(), 'silithid-loop-j9-worktrees-'))
    cleanups.push(() => rm(worktreesRoot, { recursive: true, force: true }))
    const artifactsRoot = await mkdtemp(join(tmpdir(), 'silithid-loop-j9-artifacts-'))
    cleanups.push(() => rm(artifactsRoot, { recursive: true, force: true }))

    const { runId } = await createFixtureProject({
      worktreesRoot,
      sourceRepoPath: sourceRepo.path,
      maxIterations: 2,
    })

    // Un seul FakeAdapter, consommé dans l'ordre par TOUS les rôles réels
    // (garant, reviewer, juge) au fil des deux itérations — aucun token,
    // aucun réseau. Ordre exact des appels `send()` :
    //   1. framing (iter 1)               → submit_frame FRAME_1
    //   2. reviewing (iter 1, round 0)     → KO
    //   3. reviewing (iter 1, round 1)     → OK  (review_round : 0→1→0)
    //   4. judging (iter 1)                → écart bloquant
    //   5. verdict (iter 1)                → ecarts + dev_prompt_correctif
    //   6. framing (iter 2)                → submit_frame FRAME_2 (doit lire le correctif)
    //   7. reviewing (iter 2)              → OK
    //   8. judging (iter 2)                → conforme
    //   9. verdict (iter 2)                → conforme → done (autonomy auto)
    const adapter = createFakeAdapter({
      replies: [
        submitFrame(FRAME_1),
        fakeKoReview(1),
        reviewOk,
        submitJudgeReport({
          conformites: [],
          ecarts: [
            {
              severite: 'bloquant',
              page: '/',
              viewport: 'desktop',
              description: 'le titre affiche "Accueil" au lieu de "Silithid"',
              screenshot_ref: 'index-desktop.png',
            },
          ],
        }),
        submitVerdict({
          decision: 'ecarts',
          ecarts: [
            {
              severite: 'bloquant',
              description: 'le titre affiche "Accueil" au lieu de "Silithid"',
              correctif: CORRECTIF,
            },
          ],
          dev_prompt_correctif: FRAME_2.dev_prompt,
        }),
        submitFrame(FRAME_2),
        reviewOk,
        submitJudgeReport({
          conformites: ['le titre "Silithid" est bien visible en <h1>'],
          ecarts: [],
        }),
        submitVerdict({ decision: 'conforme', ecarts: [] }),
      ],
    })

    // Observe chaque prompt envoyé à une session `garant` (framing.ts ET
    // verdict.ts en créent) — c'est la seule fenêtre pour constater que le
    // DEUXIÈME cadrage contient réellement le correctif, pas seulement que
    // `submit_frame` a été rappelé.
    const garantPrompts: string[] = []
    const observingAdapter: RuntimeAdapter = {
      ...adapter,
      async send(session, message, opts) {
        if (session.roleKey === 'garant') garantPrompts.push(message)
        return adapter.send(session, message, opts)
      },
    }

    const registry: StepRegistry = {
      framing: createFramingHandler({ adapter: observingAdapter, worktreesRoot }),
      coding: createFakeCodingHandler(),
      reviewing: createReviewingHandler({ adapter: observingAdapter, worktreesRoot }),
      deploying: createDeployingHandler({ artifactsRoot, target: createLocalPreviewTarget() }),
      judging: createJudgingHandler({ adapter: observingAdapter, artifactsRoot }),
      verdict: createVerdictHandler({ adapter: observingAdapter }),
    }

    // Personne ne fait tourner pg-boss ici : on pompe `stepOnce` nous-mêmes,
    // comme le ferait le worker (`registerRunStepWorker`) — avec un
    // garde-fou de diagnostic seulement, `decide()` borne déjà réellement la
    // boucle (`NO_REQUEUE_STATES`).
    const MAX_STEPS = 20
    let result = await stepOnce(db, registry, runId)
    let steps = 1
    const transitions: string[] = [`→ ${result.state}`]
    while (result.requeue && steps < MAX_STEPS) {
      result = await stepOnce(db, registry, runId)
      steps++
      transitions.push(`→ ${result.state}`)
    }

    expect(steps, `la boucle ne s'est pas arrêtée : ${transitions.join(' ')}`).toBeLessThan(
      MAX_STEPS,
    )
    expect(result.requeue, transitions.join(' ')).toBe(false)
    expect(result.state).toBe('done')

    const finalRun = await db
      .selectFrom('runs')
      .select(['iteration', 'review_round', 'state', 'ended_at'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()

    // Itération : incrémentée une fois (le seul `verdict_ecarts` du run).
    expect(finalRun.iteration).toBe(2)
    // review_round : remis à zéro par le `review_ok` du round 1 (0→1→0),
    // puis n'a plus jamais bougé de 0 sur toute l'itération 2 — la preuve
    // que le round dev↔reviewer d'un tour ne fuit jamais sur le suivant.
    expect(finalRun.review_round).toBe(0)
    expect(finalRun.state).toBe('done')
    expect(finalRun.ended_at).not.toBeNull()

    // Le correctif a bien été lu au second cadrage : PAS au premier.
    expect(garantPrompts).toHaveLength(4) // framing1, verdict1, framing2, verdict2
    expect(garantPrompts[0]).not.toContain('# Correctif du garant')
    expect(garantPrompts[2]).toContain('# Correctif du garant')
    expect(garantPrompts[2]).toContain(CORRECTIF)

    // Timeline d'audit : les passations apparaissent dans le bon ordre.
    const messages = await readRunMessages(db, runId)
    const frame1Idx = messages.findIndex(
      (m) => m.kind === 'prompt' && m.fromRole === 'garant' && m.toRole === 'dev',
    )
    const judge1Idx = messages.findIndex(
      (m) => m.kind === 'report' && m.fromRole === 'judge' && m.toRole === 'garant',
    )
    const correctionIdx = messages.findIndex(
      (m) => m.kind === 'correction' && m.fromRole === 'garant' && m.toRole === 'dev',
    )
    const frame2Idx = messages.findIndex(
      (m, i) =>
        i > correctionIdx && m.kind === 'prompt' && m.fromRole === 'garant' && m.toRole === 'dev',
    )
    const judge2Idx = messages.findIndex(
      (m, i) =>
        i > frame2Idx && m.kind === 'report' && m.fromRole === 'judge' && m.toRole === 'garant',
    )
    const verdictConformeIdx = messages.findIndex(
      (m, i) =>
        i > judge2Idx &&
        m.kind === 'report' &&
        m.fromRole === 'garant' &&
        m.toRole === 'system' &&
        m.meta.decision === 'conforme',
    )

    expect(frame1Idx, 'cadrage 1 introuvable').toBeGreaterThanOrEqual(0)
    expect(judge1Idx, 'rapport du juge 1 doit suivre le cadrage 1').toBeGreaterThan(frame1Idx)
    expect(correctionIdx, 'correctif doit suivre le rapport du juge 1').toBeGreaterThan(judge1Idx)
    expect(frame2Idx, 'cadrage 2 doit suivre le correctif').toBeGreaterThan(correctionIdx)
    expect(judge2Idx, 'rapport du juge 2 doit suivre le cadrage 2').toBeGreaterThan(frame2Idx)
    expect(
      verdictConformeIdx,
      'verdict conforme final doit suivre le rapport du juge 2',
    ).toBeGreaterThan(judge2Idx)

    const koToDev = messages.filter(
      (m) => m.kind === 'report' && m.fromRole === 'reviewer' && m.toRole === 'dev',
    )
    expect(koToDev).toHaveLength(1)
  },
)

test(
  'épuisement : verdict_ecarts à la dernière itération -> failed + inbox alert (le câblage atteint bien decide())',
  { timeout: 60_000 },
  async () => {
    const sourceRepo = await createThrowawayRepo()
    cleanups.push(sourceRepo.dispose)
    const worktreesRoot = await mkdtemp(join(tmpdir(), 'silithid-loop-j9-exhaust-worktrees-'))
    cleanups.push(() => rm(worktreesRoot, { recursive: true, force: true }))
    const artifactsRoot = await mkdtemp(join(tmpdir(), 'silithid-loop-j9-exhaust-artifacts-'))
    cleanups.push(() => rm(artifactsRoot, { recursive: true, force: true }))

    // Une seule itération possible : le verdict "ecarts" qui suit n'a donc
    // structurellement aucun tour suivant pour appliquer un correctif —
    // `decide()` doit basculer directement sur `failed` (domain/run-state.ts).
    const { runId, projectId } = await createFixtureProject({
      worktreesRoot,
      sourceRepoPath: sourceRepo.path,
      maxIterations: 1,
    })

    const adapter = createFakeAdapter({
      replies: [
        submitFrame(FRAME_1),
        reviewOk,
        submitJudgeReport({
          conformites: [],
          ecarts: [
            {
              severite: 'bloquant',
              page: '/',
              viewport: 'desktop',
              description: 'le titre affiche "Accueil" au lieu de "Silithid"',
              screenshot_ref: 'index-desktop.png',
            },
          ],
        }),
        // Dernière itération : le garant arbitre "ecarts" sans correctif —
        // exactement le cas documenté en tête de `verdict.ts` (aucun tour
        // suivant ne le lirait jamais).
        submitVerdict({
          decision: 'ecarts',
          ecarts: [
            {
              severite: 'bloquant',
              description: 'le titre affiche "Accueil" au lieu de "Silithid"',
              correctif: CORRECTIF,
            },
          ],
        }),
      ],
    })

    const registry: StepRegistry = {
      framing: createFramingHandler({ adapter, worktreesRoot }),
      coding: createFakeCodingHandler(),
      reviewing: createReviewingHandler({ adapter, worktreesRoot }),
      deploying: createDeployingHandler({ artifactsRoot, target: createLocalPreviewTarget() }),
      judging: createJudgingHandler({ adapter, artifactsRoot }),
      verdict: createVerdictHandler({ adapter }),
    }

    const MAX_STEPS = 20
    let result = await stepOnce(db, registry, runId)
    let steps = 1
    while (result.requeue && steps < MAX_STEPS) {
      result = await stepOnce(db, registry, runId)
      steps++
    }

    expect(steps).toBeLessThan(MAX_STEPS)
    expect(result.requeue).toBe(false)
    expect(result.state).toBe('failed')

    const finalRun = await db
      .selectFrom('runs')
      .select(['iteration', 'state', 'ended_at'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(finalRun.iteration).toBe(1) // jamais incrémentée : pas de tour suivant
    expect(finalRun.state).toBe('failed')
    expect(finalRun.ended_at).not.toBeNull()

    const alerts = await db
      .selectFrom('inbox_items')
      .selectAll()
      .where('run_id', '=', runId)
      .where('type', '=', 'alert')
      .execute()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.title).toContain('itérations épuisées')
    expect(alerts[0]?.from_role).toBe('garant')
    expect(alerts[0]?.project_id).toBe(projectId)

    // Aucune passation garant→dev "correction" : rien n'a jamais lu
    // `verdict.dev_prompt_correctif` (que le garant n'a d'ailleurs pas rendu).
    const messages = await readRunMessages(db, runId)
    expect(messages.find((m) => m.kind === 'correction')).toBeUndefined()

    // Le worker ne rappelle plus jamais le handler au-delà de l'état terminal.
    const again = await stepOnce(db, registry, runId)
    expect(again).toEqual({ applied: false, state: 'failed', requeue: false })
  },
)

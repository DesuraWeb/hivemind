import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { projectRepoPath } from '../src/git/repo'
import { runWorktreePath } from '../src/git/worktree'
import { type StepRegistry, stepOnce } from '../src/jobs/run-step'
import { appendMessage, readRunMessages } from '../src/loop/bus'
import { createFramingHandler } from '../src/loop/steps/framing'
import { createReviewingHandler } from '../src/loop/steps/reviewing'
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
  await db.destroy()
})

// Répertoires réels sous /tmp : démontés dans l'ordre inverse de création,
// même si une assertion échoue en cours de test.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

const FAKE_FRAME = {
  dev_prompt:
    'Ajoute un endpoint GET /healthz qui renvoie 200 avec { ok: true }, sans dépendance externe.',
  acceptance_criteria: ['GET /healthz renvoie 200 avec le corps { ok: true }'],
  pages_to_judge: [] as string[],
}

function fakeKoReview(round: number) {
  return {
    toolUse: {
      name: 'submit_review',
      input: {
        verdict: 'KO',
        points: [{ file: 'src/healthz.js', action: `corrige le point du tour ${round}` }],
      },
    },
  }
}

/** Marqueur écrit dans le worktree du dev mais jamais commité — la preuve
 * que le reviewer, s'il travaille au bon endroit, ne peut pas le voir. */
const DEV_SCRATCH_FILE = 'DEV_SCRATCH_NOT_COMMITTED.txt'

const DEV_COMMIT_IDENTITY = ['-c', 'user.name=Test Dev', '-c', 'user.email=dev@silithid.invalid']

/**
 * Double de test pour `coding.ts` (Task 10, déjà couvert par son propre
 * smoke réel — pas retesté ici) : produit les mêmes effets observables
 * qu'un vrai tour de dev — un commit réel poussé sur `run/<runId>`, une "PR"
 * (fictive : pas de GitHub dans ce test, aucun réseau) numérotée, un
 * rapport dev→garant dans le bus — sans agent réel. Le `FakeAdapter` ne
 * touche jamais le disque, il ne peut donc pas produire de vrai diff à
 * committer ; `reviewing.ts`, lui, EST le code réel sous test ci-dessous.
 *
 * Laisse aussi un fichier non commité (`DEV_SCRATCH_FILE`) dans le
 * worktree du dev à chaque tour, jamais nettoyé : si `reviewing.ts` regardait
 * par erreur ce worktree au lieu du sien, ce fichier y serait visible.
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

    await writeFile(join(worktreePath, 'healthz.txt'), `tentative ${round} pour ${runId}\n`)
    await run('git', ['add', 'healthz.txt'], { cwd: worktreePath })
    await run('git', [...DEV_COMMIT_IDENTITY, 'commit', '-m', `feat: tentative ${round}`], {
      cwd: worktreePath,
    })
    // Jamais ajouté à l'index, jamais commité : reste sur le disque du
    // worktree du dev — c'est justement ce que le reviewer ne doit pas voir.
    await writeFile(join(worktreePath, DEV_SCRATCH_FILE), `brouillon du dev, tour ${round}\n`)

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
      body: `Tour ${round} : endpoint ajouté, tests locaux passés (rapport du dev).`,
      meta: { pr_number: prNumber, pr_url: `https://example.invalid/pull/${prNumber}`, branch },
    })

    return { type: 'pr_opened', prNumber }
  }
}

test('reviewer KO x3 -> awaiting_human + inbox alert, jamais de boucle infinie (critère J5)', async () => {
  const sourceRepo = await createThrowawayRepo()
  cleanups.push(sourceRepo.dispose)
  const worktreesRoot = await mkdtemp(join(tmpdir(), 'silithid-review-loop-'))
  cleanups.push(() => rm(worktreesRoot, { recursive: true, force: true }))

  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe review', slug: `globe-review-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const client = await db
    .insertInto('clients')
    .values({ name: 'Client review' })
    .returning('id')
    .executeTakeFirstOrThrow()

  const projectSlug = `projet-review-${randomUUID()}`

  // Pré-clone manuel, à l'endroit exact où `ensureProjectRepo` cherchera un
  // clone existant (`projectRepoPath`, décision C) : les vrais handlers
  // (`framing.ts`, `reviewing.ts`) dérivent bien une URL GitHub depuis
  // `repo_full_name`, mais comme le clone existe déjà, `ensureProjectRepo`
  // se contente d'un `fetch` sur `origin` — ici le dépôt local jetable.
  // Aucun accès réseau dans ce test.
  const repoPath = projectRepoPath(worktreesRoot, projectSlug)
  await mkdir(dirname(repoPath), { recursive: true })
  await run('git', ['clone', sourceRepo.path, repoPath])

  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      client_id: client.id,
      name: 'Projet review',
      slug: projectSlug,
      repo_full_name: 'silithid/sandbox-review-loop',
      default_branch: 'main',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const step = await db
    .insertInto('steps')
    .values({
      project_id: project.id,
      position: 1,
      title: 'Step review',
      specs: '## Cadrer, coder, revoir',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const startedRun = await db
    .insertInto('runs')
    .values({ step_id: step.id })
    .returning('id')
    .executeTakeFirstOrThrow()
  const runId = startedRun.id

  // Scripté : un cadrage, puis trois KO d'affilée. Un seul FakeAdapter,
  // consommé dans l'ordre par framing puis par les trois tours de revue —
  // aucun token, aucun réseau.
  const adapter = createFakeAdapter({
    replies: [
      { toolUse: { name: 'submit_frame', input: FAKE_FRAME } },
      fakeKoReview(1),
      fakeKoReview(2),
      fakeKoReview(3),
    ],
  })

  // Observe chaque session reviewer au moment de sa création, avant que
  // `reviewing.ts` ne nettoie son worktree en sortie : c'est la seule
  // fenêtre pour constater sur le disque que ce worktree est distinct de
  // celui du dev et ne contient pas son brouillon non commité.
  let observedReviewerCwd: string | undefined
  let reviewerCwdDistinctFromDevWorktree: boolean | undefined
  let reviewerSawDevScratchFile: boolean | undefined
  const observingAdapter: RuntimeAdapter = {
    ...adapter,
    async createSession(opts) {
      if (opts.roleKey === 'reviewer') {
        observedReviewerCwd = opts.cwd
        reviewerCwdDistinctFromDevWorktree = opts.cwd !== runWorktreePath(repoPath, runId)
        reviewerSawDevScratchFile = await stat(join(opts.cwd, DEV_SCRATCH_FILE))
          .then(() => true)
          .catch(() => false)
      }
      return adapter.createSession(opts)
    },
  }

  let reviewingCalls = 0
  const realReviewing = createReviewingHandler({ adapter: observingAdapter, worktreesRoot })
  const registry: StepRegistry = {
    framing: createFramingHandler({ adapter: observingAdapter, worktreesRoot }),
    coding: createFakeCodingHandler(),
    reviewing: async (stepDb, id) => {
      reviewingCalls++
      return realReviewing(stepDb, id)
    },
  }

  // Personne ne fait tourner pg-boss ici : on pompe `stepOnce` nous-mêmes,
  // comme le ferait le worker (`registerRunStepWorker`), avec un garde-fou —
  // si la borne des 3 allers-retours ne s'appliquait pas, ce test échouerait
  // au lieu de bloquer indéfiniment le runner.
  const MAX_STEPS = 20
  let result = await stepOnce(db, registry, runId)
  let steps = 1
  while (result.requeue && steps < MAX_STEPS) {
    result = await stepOnce(db, registry, runId)
    steps++
  }

  expect(
    steps,
    'la boucle ne s’est jamais arrêtée — borne des 3 rounds non respectée',
  ).toBeLessThan(MAX_STEPS)
  expect(result.requeue).toBe(false)
  expect(result.state).toBe('awaiting_human')
  expect(reviewingCalls).toBe(3)

  // Le worktree du reviewer était bien distinct de celui du dev, et ne
  // contenait pas son brouillon non commité — "worktree propre" (brief).
  expect(observedReviewerCwd).toBeDefined()
  expect(reviewerCwdDistinctFromDevWorktree).toBe(true)
  expect(reviewerSawDevScratchFile).toBe(false)

  const runAfter = await db
    .selectFrom('runs')
    .select(['state', 'resume_state', 'review_round'])
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(runAfter.state).toBe('awaiting_human')
  // `decide()` (Task 4, non modifié ici) : le 3e KO bascule directement sans
  // incrémenter une 3e fois — round 0 -> 1 (KO 1) -> 2 (KO 2) -> awaiting_human (KO 3).
  expect(runAfter.review_round).toBe(2)
  expect(runAfter.resume_state).toBe('reviewing')

  const alerts = await db
    .selectFrom('inbox_items')
    .selectAll()
    .where('run_id', '=', runId)
    .where('type', '=', 'alert')
    .execute()
  expect(alerts).toHaveLength(1)
  expect(alerts[0]?.title).toContain('épuisée')

  const messages = await readRunMessages(db, runId)
  const koToDevs = messages.filter(
    (m) => m.kind === 'report' && m.fromRole === 'reviewer' && m.toRole === 'dev',
  )
  expect(koToDevs).toHaveLength(3)
  const okToGarant = messages.filter(
    (m) => m.kind === 'report' && m.fromRole === 'reviewer' && m.toRole === 'garant',
  )
  expect(okToGarant).toHaveLength(0)

  // Au-delà de la borne : `awaiting_human` n'est plus un état actif, le
  // worker ne rappelle plus jamais le handler — la preuve que ça s'ARRÊTE,
  // pas seulement qu'on a compté jusqu'à 3.
  const fourthAttempt = await stepOnce(db, registry, runId)
  expect(fourthAttempt).toEqual({ applied: false, state: 'awaiting_human', requeue: false })
  expect(reviewingCalls, 'le handler reviewing a été rappelé au-delà de la borne').toBe(3)
})

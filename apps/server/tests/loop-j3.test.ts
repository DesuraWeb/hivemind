import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { ensureProjectRepo } from '../src/git/repo'
import { addRunWorktree, removeRunWorktree, runWorktreePath } from '../src/git/worktree'
import { type StepRegistry, stepOnce } from '../src/jobs/run-step'
import { appendMessage, readRunMessages } from '../src/loop/bus'
import { resolveProjectRole } from '../src/loop/roles'
import { createFakeAdapter } from '../src/runtime/fake'
import { collectStructured, frameSchema } from '../src/runtime/structured'
import type { ToolPolicy } from '../src/runtime/types'
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

// Répertoires réels créés sur disque (dépôt source + racine des worktrees) :
// démontés dans l'ordre inverse de création, même si une assertion échoue.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

/** Ce que la sortie structurée factice du garant contient, réutilisé par les assertions. */
const FAKE_FRAME = {
  dev_prompt:
    'Ajoute un endpoint GET /healthz qui renvoie 200 avec { ok: true }, sans dépendance externe.',
  acceptance_criteria: ['GET /healthz renvoie 200 avec le corps { ok: true }'],
  pages_to_judge: [] as string[],
}

/**
 * Handler factice de l'état `framing` (Task 9 — critère J3).
 *
 * Assemble les briques déjà testées séparément — résolution de rôle,
 * clone + worktree git, `FakeAdapter` + sortie structurée, bus — pour
 * prouver qu'elles s'emboîtent. `framing.ts` (Task 10) reprendra cette forme
 * avec un vrai `RuntimeAdapter` ; ici aucun modèle n'est appelé.
 *
 * `onWorktreeReady` est notifié une fois le worktree créé, avant que ce même
 * handler ne le nettoie en fin de step — c'est le point où le test constate
 * sur le disque que la création a bien eu lieu, avant que la preuve ne
 * disparaisse.
 */
function createFakeFramingHandler(opts: {
  worktreesRoot: string
  projectId: string
  projectSlug: string
  sourceRepoPath: string
  onWorktreeReady: (worktreePath: string, repoPath: string) => Promise<void>
}): StepRegistry {
  return {
    framing: async (stepDb, runId) => {
      const role = await resolveProjectRole(stepDb, opts.projectId, 'garant')

      const repoPath = await ensureProjectRepo({
        worktreesRoot: opts.worktreesRoot,
        projectSlug: opts.projectSlug,
        remoteUrl: opts.sourceRepoPath,
      })
      const worktreePath = await addRunWorktree(repoPath, runId)
      await opts.onWorktreeReady(worktreePath, repoPath)

      const adapter = createFakeAdapter({
        replies: [{ toolUse: { name: 'submit_frame', input: FAKE_FRAME } }],
      })
      const session = await adapter.createSession({
        roleKey: 'garant',
        systemPrompt: role.systemPrompt,
        cwd: worktreePath,
        // Persisté en JSON (`role_templates.tools`) donc non typé à la
        // lecture : la forme est garantie par `db/seed.ts` (TOOLS), pas par
        // le compilateur — d'où le détour par `unknown`.
        tools: role.tools as unknown as ToolPolicy,
        onEvent: () => {},
      })

      const frame = await collectStructured(adapter, session, 'Cadre ce step.', frameSchema, {
        toolName: 'submit_frame',
        toolDescription:
          'Rend le cadrage du step (dev_prompt, acceptance_criteria, pages_to_judge).',
      })

      // La passation garant→dev : c'est elle que le dev lira pour démarrer.
      await appendMessage(stepDb, {
        runId,
        fromRole: 'garant',
        toRole: 'dev',
        kind: 'prompt',
        body: frame.dev_prompt,
        meta: {
          acceptance_criteria: frame.acceptance_criteria,
          pages_to_judge: frame.pages_to_judge,
        },
      })

      // Factice ici : le vrai coding.ts (Task 10) garderait le worktree
      // ouvert pour que le dev y travaille. Cette tâche prouve seulement que
      // le cycle création → nettoyage fonctionne de bout en bout.
      await removeRunWorktree(repoPath, runId)

      return { type: 'frame_ready' }
    },
  }
}

test('boucle framing -> coding factice tracee de bout en bout (critere J3)', async () => {
  // Dépôt git local jetable — jamais GitHub, cf. tests/git-worktree.test.ts.
  const sourceRepo = await createThrowawayRepo()
  cleanups.push(sourceRepo.dispose)
  const worktreesRoot = await mkdtemp(join(tmpdir(), 'chapo-j3-worktrees-'))
  cleanups.push(() => rm(worktreesRoot, { recursive: true, force: true }))

  // globe → client → projet → step → run
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe J3', slug: `globe-j3-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()

  const client = await db
    .insertInto('clients')
    .values({ name: 'Client J3' })
    .returning('id')
    .executeTakeFirstOrThrow()

  const projectSlug = `projet-j3-${randomUUID()}`
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      client_id: client.id,
      name: 'Projet J3',
      slug: projectSlug,
      repo_full_name: 'chapo/sandbox-j3',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const step = await db
    .insertInto('steps')
    .values({
      project_id: project.id,
      position: 1,
      title: 'Step J3',
      specs: '## Cadrer puis coder un endpoint de healthcheck',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const startedRun = await db
    .insertInto('runs')
    .values({ step_id: step.id })
    .returning('id')
    .executeTakeFirstOrThrow()
  const runId = startedRun.id

  // État de départ vérifié explicitement : la transition qu'on observe plus
  // bas part bien de `framing`, pas d'un défaut de fixture.
  const runBefore = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(runBefore.state).toBe('framing')
  expect(await readRunMessages(db, runId)).toHaveLength(0)

  let worktreeExistedOnDiskWhenCreated = false
  let createdWorktreePath: string | undefined
  let createdRepoPath: string | undefined

  const registry = createFakeFramingHandler({
    worktreesRoot,
    projectId: project.id,
    projectSlug,
    sourceRepoPath: sourceRepo.path,
    onWorktreeReady: async (worktreePath, repoPath) => {
      createdWorktreePath = worktreePath
      createdRepoPath = repoPath
      // Constaté pendant que le worktree existe encore : le handler ne le
      // nettoie qu'après être passé ici.
      worktreeExistedOnDiskWhenCreated = await stat(worktreePath)
        .then((s) => s.isDirectory())
        .catch(() => false)
    },
  })

  const result = await stepOnce(db, registry, runId)

  expect(
    worktreeExistedOnDiskWhenCreated,
    'le worktree devait exister sur disque une fois créé',
  ).toBe(true)
  if (!createdWorktreePath || !createdRepoPath) throw new Error('worktree jamais créé')

  // 1. Le run est passé framing -> coding, en base.
  expect(result).toEqual({ applied: true, state: 'coding', requeue: true })
  const runAfter = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(runAfter.state).toBe('coding')

  // 2. `messages` contient la passation garant->dev, lisible via readRunMessages.
  const messages = await readRunMessages(db, runId)
  const handoff = messages.find((m) => m.kind === 'prompt')
  expect(handoff).toBeDefined()
  expect(handoff?.fromRole).toBe('garant')
  expect(handoff?.toRole).toBe('dev')
  expect(handoff?.body).toBe(FAKE_FRAME.dev_prompt)
  expect(handoff?.meta).toMatchObject({ acceptance_criteria: FAKE_FRAME.acceptance_criteria })

  // L'audit système de la transition (orchestrateur, Task 8) est bien tracé
  // en plus de la passation garant->dev.
  const systemAudit = messages.find((m) => m.kind === 'info')
  expect(systemAudit?.body).toContain('framing → coding')

  // 3. Le worktree a bien été créé PUIS nettoyé — vérifié sur le disque après coup.
  expect(createdWorktreePath).toBe(runWorktreePath(createdRepoPath, runId))
  await expect(stat(createdWorktreePath)).rejects.toThrow() // répertoire disparu du disque
  const { stdout: worktreeList } = await run('git', ['worktree', 'list', '--porcelain'], {
    cwd: createdRepoPath,
  })
  expect(worktreeList).not.toContain(createdWorktreePath) // git ne le référence plus non plus
})

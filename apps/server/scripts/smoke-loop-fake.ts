/**
 * Smoke test du critère de fin J3 (plan Phase 2, Task 9) : fait tourner une
 * boucle `framing -> coding` complète — fixtures DB, worker `run.step`,
 * `FakeAdapter` + sortie structurée, worktree git, bus de messages — puis
 * affiche la timeline d'audit du run. Aucun modèle réel n'est appelé, aucun
 * token consommé : c'est l'outil de diagnostic du reste du sprint, à
 * relancer chaque fois qu'on veut voir une boucle s'exécuter sans payer pour
 * la regarder.
 *
 *   pnpm --filter @chapo/server exec tsx scripts/smoke-loop-fake.ts
 *
 * Écrit puis nettoie ses propres lignes (globe/client/projet/step/run) dans
 * la base configurée par DATABASE_URL — rejouable sans laisser de trace.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { closeDb, getDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { ensureProjectRepo } from '../src/git/repo'
import { addRunWorktree, removeRunWorktree, runWorktreePath } from '../src/git/worktree'
import { type StepRegistry, stepOnce } from '../src/jobs/run-step'
import { type StoredMessage, appendMessage, readRunMessages } from '../src/loop/bus'
import { resolveProjectRole } from '../src/loop/roles'
import { createFakeAdapter } from '../src/runtime/fake'
import { collectStructured, frameSchema } from '../src/runtime/structured'
import type { ToolPolicy } from '../src/runtime/types'
import { createThrowawayRepo } from '../src/runtime/worktree'

const run = promisify(execFile)

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

/** Timeline d'audit lisible : une ligne par message, colonnes alignées. */
function printTimeline(messages: StoredMessage[]): void {
  if (messages.length === 0) {
    console.log('  (aucun message)')
    return
  }
  for (const m of messages) {
    const time = m.createdAt.toISOString().slice(11, 23) // HH:MM:SS.mmm
    const route = `${m.fromRole} → ${m.toRole}`.padEnd(18)
    const kind = m.kind.padEnd(10)
    const excerpt = m.body.replace(/\s+/g, ' ').trim().slice(0, 80)
    console.log(`  ${time}  ${route}  ${kind}  ${excerpt}`)
  }
}

const db = getDb()
// Idempotent (schema_migrations) : ne réapplique jamais une migration déjà
// jouée, donc sans danger à lancer contre une base déjà à jour.
await runMigrations(db)
await seedRoleTemplates(db)

section('Fixtures')

const sourceRepo = await createThrowawayRepo()
const worktreesRoot = await mkdtemp(join(tmpdir(), 'chapo-smoke-j3-worktrees-'))
console.log(`  dépôt source jetable : ${sourceRepo.path}`)
console.log(`  racine des worktrees : ${worktreesRoot}`)

const globe = await db
  .insertInto('globes')
  .values({ name: 'Smoke J3', slug: `smoke-j3-${randomUUID()}` })
  .returning('id')
  .executeTakeFirstOrThrow()

const client = await db
  .insertInto('clients')
  .values({ name: 'Client smoke J3' })
  .returning('id')
  .executeTakeFirstOrThrow()

const projectSlug = `smoke-j3-${randomUUID()}`
const project = await db
  .insertInto('projects')
  .values({
    globe_id: globe.id,
    client_id: client.id,
    name: 'Projet smoke J3',
    slug: projectSlug,
    repo_full_name: 'chapo/sandbox-smoke-j3',
  })
  .returning('id')
  .executeTakeFirstOrThrow()

const step = await db
  .insertInto('steps')
  .values({
    project_id: project.id,
    position: 1,
    title: 'Step smoke J3',
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

console.log(`  globe=${globe.id} client=${client.id} projet=${project.id} step=${step.id}`)
console.log(`  run=${runId} état initial=framing`)

let worktreePath: string | undefined
let repoPath: string | undefined
let worktreeExistedOnDisk = false

// Handler factice de l'état `framing` : mêmes briques que Task 10 câblera
// avec un vrai modèle (rôle, worktree, sortie structurée, bus), scriptées
// ici avec le FakeAdapter — voir tests/loop-j3.test.ts pour le détail
// commenté brique par brique.
const registry: StepRegistry = {
  framing: async (stepDb, id) => {
    const role = await resolveProjectRole(stepDb, project.id, 'garant')

    repoPath = await ensureProjectRepo({
      worktreesRoot,
      projectSlug,
      remoteUrl: sourceRepo.path,
    })
    worktreePath = await addRunWorktree(repoPath, id)
    worktreeExistedOnDisk = await stat(worktreePath)
      .then((s) => s.isDirectory())
      .catch(() => false)

    const adapter = createFakeAdapter({
      replies: [
        {
          toolUse: {
            name: 'submit_frame',
            input: {
              dev_prompt:
                'Ajoute un endpoint GET /healthz qui renvoie 200 avec { ok: true }, sans dépendance externe.',
              acceptance_criteria: ['GET /healthz renvoie 200 avec le corps { ok: true }'],
              pages_to_judge: [],
            },
          },
        },
      ],
    })
    const session = await adapter.createSession({
      roleKey: 'garant',
      systemPrompt: role.systemPrompt,
      cwd: worktreePath,
      // Persisté en JSON (`role_templates.tools`), non typé à la lecture —
      // d'où le détour par `unknown` (même remarque que tests/loop-j3.test.ts).
      tools: role.tools as unknown as ToolPolicy,
      onEvent: () => {},
    })

    const frame = await collectStructured(adapter, session, 'Cadre ce step.', frameSchema, {
      toolName: 'submit_frame',
      toolDescription: 'Rend le cadrage du step (dev_prompt, acceptance_criteria, pages_to_judge).',
    })

    await appendMessage(stepDb, {
      runId: id,
      fromRole: 'garant',
      toRole: 'dev',
      kind: 'prompt',
      body: frame.dev_prompt,
      meta: {
        acceptance_criteria: frame.acceptance_criteria,
        pages_to_judge: frame.pages_to_judge,
      },
    })

    // Factice : le vrai coding.ts (Task 10) garderait le worktree ouvert
    // pour le dev. Ici on prouve seulement création -> nettoyage.
    await removeRunWorktree(repoPath, id)

    return { type: 'frame_ready' }
  },
}

section('Exécution : stepOnce(framing)')
const result = await stepOnce(db, registry, runId)
console.log(
  `  résultat : applied=${result.applied} state=${result.state} requeue=${result.requeue}`,
)

section('Worktree')
if (!worktreePath || !repoPath) throw new Error('le handler factice n’a jamais créé de worktree')
console.log(`  chemin attendu      : ${runWorktreePath(repoPath, runId)}`)
console.log(`  créé (constaté)     : ${worktreeExistedOnDisk ? 'oui' : 'NON — voir ci-dessus'}`)
const stillOnDisk = await stat(worktreePath)
  .then(() => true)
  .catch(() => false)
const { stdout: worktreeList } = await run('git', ['worktree', 'list', '--porcelain'], {
  cwd: repoPath,
})
const stillInGit = worktreeList.includes(worktreePath)
console.log(`  nettoyé (disque)    : ${!stillOnDisk ? 'oui' : 'NON — toujours présent'}`)
console.log(`  nettoyé (git)       : ${!stillInGit ? 'oui' : 'NON — toujours listé'}`)

section(`Timeline d'audit (run ${runId})`)
const messages = await readRunMessages(db, runId)
printTimeline(messages)

section('Nettoyage')
// Cascade FK (projects -> steps -> runs -> messages/inbox_items/...) : un
// seul delete suffit pour le run entier. Client et globe supprimés à part.
await db.deleteFrom('projects').where('id', '=', project.id).execute()
await db.deleteFrom('clients').where('id', '=', client.id).execute()
await db.deleteFrom('globes').where('id', '=', globe.id).execute()
await rm(worktreesRoot, { recursive: true, force: true })
await sourceRepo.dispose()
await closeDb()
console.log('  fixtures DB et répertoires temporaires supprimés')

const finalStateOk = result.applied && result.state === 'coding' && result.requeue
const handoffTraced = messages.some(
  (m) => m.kind === 'prompt' && m.fromRole === 'garant' && m.toRole === 'dev',
)
const worktreeLifecycleOk = worktreeExistedOnDisk && !stillOnDisk && !stillInGit
const ok = finalStateOk && handoffTraced && worktreeLifecycleOk

console.log()
if (ok) {
  console.log('✅ Critère J3 : framing -> coding tracé en base, worktree créé puis nettoyé.')
} else {
  console.error('❌ Critère J3 non satisfait :')
  if (!finalStateOk) console.error(`   - état final inattendu : ${JSON.stringify(result)}`)
  if (!handoffTraced) console.error('   - passation garant→dev absente de la timeline')
  if (!worktreeLifecycleOk)
    console.error('   - cycle de vie du worktree incorrect (voir ci-dessus)')
  process.exitCode = 1
}

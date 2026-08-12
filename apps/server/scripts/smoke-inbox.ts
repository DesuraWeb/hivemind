/**
 * Smoke test du critère de fin J6 (plan Phase 3, Task 5) : une question
 * bloquante lève un item d'inbox, diffuse `run.state` + `inbox.new` sur le
 * bus SSE, se résout via l'API HTTP réelle (`POST /api/inbox/:id/resolve`,
 * pas un appel direct à `resolveInboxItem`), puis fait réellement repartir le
 * run — pas seulement marquer l'item `done`. Aucun modèle réel n'est appelé,
 * aucun token consommé : `FakeAdapter` uniquement, même patron que
 * `scripts/smoke-loop-fake.ts` (critère J3), timeline d'audit comprise.
 *
 *   pnpm --filter @silithid/server exec tsx scripts/smoke-inbox.ts
 *
 * Écrit puis nettoie ses propres lignes (globe/client/projet/step/run,
 * utilisateur éphémère) dans la base configurée par DATABASE_URL —
 * rejouable sans laisser de trace.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { closeDb, getDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { loadEnv } from '../src/env'
import type { BusEvent } from '../src/events/bus'
import { eventBus } from '../src/events/bus'
import { getInboxItem } from '../src/inbox/repo'
import { createBoss } from '../src/jobs/boss'
import { RUN_STEP_QUEUE, type StepRegistry, stepOnce } from '../src/jobs/run-step'
import { type StoredMessage, appendMessage, readRunMessages } from '../src/loop/bus'
import { createFakeAdapter } from '../src/runtime/fake'
import { collectStructured, frameSchema } from '../src/runtime/structured'
import type { ToolPolicy } from '../src/runtime/types'

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

/** Timeline d'audit lisible : une ligne par message, colonnes alignées (repris de smoke-loop-fake.ts). */
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

function printBusEvents(events: BusEvent[]): void {
  if (events.length === 0) {
    console.log('  (aucun événement capté)')
    return
  }
  for (const e of events) console.log(`  ${JSON.stringify(e)}`)
}

const env = loadEnv()
const db = getDb()
// Idempotent (schema_migrations) : sans danger contre une base déjà à jour.
await runMigrations(db)

section('Fixtures')

const globe = await db
  .insertInto('globes')
  .values({ name: 'Smoke J6', slug: `smoke-j6-${randomUUID()}` })
  .returning('id')
  .executeTakeFirstOrThrow()

const client = await db
  .insertInto('clients')
  .values({ name: 'Client smoke J6' })
  .returning('id')
  .executeTakeFirstOrThrow()

const project = await db
  .insertInto('projects')
  .values({
    globe_id: globe.id,
    client_id: client.id,
    name: 'Projet smoke J6',
    slug: `smoke-j6-${randomUUID()}`,
    repo_full_name: 'silithid/sandbox-smoke-j6',
  })
  .returning('id')
  .executeTakeFirstOrThrow()

const step = await db
  .insertInto('steps')
  .values({
    project_id: project.id,
    position: 1,
    title: 'Step smoke J6',
    specs: '## Cadrer un step qui a besoin d’une clarification humaine',
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

// Utilisateur éphémère, login unique : ne touche jamais un compte existant de
// la base (ex. celui de dev), supprimé en fin de script.
const login = `smoke-inbox-${randomUUID()}`
const password = 'smoke-inbox-mot-de-passe-temporaire'
const user = await createUser(db, login, password)
console.log(`  utilisateur éphémère=${login}`)

const boss = createBoss(env)
await boss.start()
await boss.createQueue(RUN_STEP_QUEUE)

// FakeAdapter explicite : buildApp construirait sinon un adapter réel selon
// RUNTIME_ADAPTER (.env : "claude" par défaut). Aucun token ne doit pouvoir
// être consommé par ce script, même indirectement.
const app = await buildApp({ db, boss, adapter: createFakeAdapter() })
await app.ready()

const loginRes = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { login, password },
})
const cookie = loginRes.cookies.find((c) => c.name === 'hm_session')?.value
if (!cookie) throw new Error('connexion smoke : aucun cookie de session reçu')

/** Cadrage factice renvoyé par le garant une fois sa question résolue. */
const FAKE_FRAME = {
  dev_prompt:
    'Ajoute un endpoint GET /healthz qui renvoie 200 avec { ok: true }, sans dépendance externe.',
  acceptance_criteria: ['GET /healthz renvoie 200 avec le corps { ok: true }'],
  pages_to_judge: [] as string[],
}

/**
 * Handler factice de l'état `framing` : pose une question bloquante au
 * premier passage, termine le cadrage au second — celui déclenché par la
 * reprise du run après résolution de l'item. Voir tests/loop-j6.test.ts pour
 * le détail commenté brique par brique.
 */
let asked = false
const registry: StepRegistry = {
  framing: async (stepDb, id) => {
    if (!asked) {
      asked = true
      await appendMessage(stepDb, {
        runId: id,
        fromRole: 'garant',
        toRole: 'system',
        kind: 'question',
        body: 'Le client a-t-il déjà une organisation GitHub existante ?',
      })
      return { type: 'question', blocking: true, fromRole: 'garant' }
    }

    const adapter = createFakeAdapter({
      replies: [{ toolUse: { name: 'submit_frame', input: FAKE_FRAME } }],
    })
    const session = await adapter.createSession({
      roleKey: 'garant',
      systemPrompt: 'Tu es le garant.',
      cwd: process.cwd(),
      tools: { bash: false, fs: 'none', mcp: [] } satisfies ToolPolicy,
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
    return { type: 'frame_ready' }
  },
}

// Abonnement RÉEL au bus SSE : on constate ce qui est diffusé, on ne le
// suppose pas.
const busEvents: BusEvent[] = []
const unsubscribe = eventBus.subscribe((e) => busEvents.push(e))

async function pendingRunStepJobs(): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from pgboss.job
    where name = ${RUN_STEP_QUEUE} and data->>'runId' = ${runId}
  `.execute(db)
  return Number(rows.rows[0]?.count ?? 0)
}

section('Étape 1 : le garant pose une question bloquante (stepOnce)')
const blocked = await stepOnce(db, registry, runId)
console.log(
  `  résultat : applied=${blocked.applied} state=${blocked.state} requeue=${blocked.requeue}`,
)

const runAfterQuestion = await db
  .selectFrom('runs')
  .select(['state', 'resume_state'])
  .where('id', '=', runId)
  .executeTakeFirstOrThrow()
console.log(
  `  run.state=${runAfterQuestion.state} run.resume_state=${runAfterQuestion.resume_state}`,
)

const itemRow = await db
  .selectFrom('inbox_items')
  .select('id')
  .where('run_id', '=', runId)
  .executeTakeFirstOrThrow()
const itemBefore = await getInboxItem(db, itemRow.id)
if (!itemBefore) throw new Error('item introuvable juste après sa création')
console.log('  item avant résolution :')
console.log(
  `    id=${itemBefore.id} type=${itemBefore.type} status=${itemBefore.status} fromRole=${itemBefore.fromRole} title=${JSON.stringify(itemBefore.title)}`,
)

section('Diffusion SSE captée jusqu’ici')
printBusEvents(busEvents)

section('Étape 2 : résolution via POST /api/inbox/:id/resolve (API HTTP réelle)')
const jobsBefore = await pendingRunStepJobs()
const resolveRes = await app.inject({
  method: 'POST',
  url: `/api/inbox/${itemBefore.id}/resolve`,
  payload: { response: { text: 'Non, à créer.' } },
  cookies: { hm_session: cookie },
})
console.log(`  POST /api/inbox/${itemBefore.id}/resolve → ${resolveRes.statusCode}`)
console.log(`  corps : ${resolveRes.body}`)

const itemAfter = await getInboxItem(db, itemBefore.id)
console.log('  item après résolution :')
console.log(
  `    status=${itemAfter?.status} humanResponse=${JSON.stringify(itemAfter?.humanResponse)} resolvedAt=${itemAfter?.resolvedAt?.toISOString()}`,
)

const runAfterResolve = await db
  .selectFrom('runs')
  .select(['state', 'resume_state'])
  .where('id', '=', runId)
  .executeTakeFirstOrThrow()
const jobsAfter = await pendingRunStepJobs()
console.log(
  `  run.state=${runAfterResolve.state} run.resume_state=${runAfterResolve.resume_state} jobs run.step en file : ${jobsBefore} → ${jobsAfter}`,
)

section('Diffusion SSE captée après résolution')
printBusEvents(busEvents)

section('Étape 3 : le run repart réellement (second stepOnce)')
const resumed = await stepOnce(db, registry, runId)
console.log(
  `  résultat : applied=${resumed.applied} state=${resumed.state} requeue=${resumed.requeue}`,
)

section(`Timeline d'audit (run ${runId})`)
const messages = await readRunMessages(db, runId)
printTimeline(messages)

unsubscribe()

section('Nettoyage')
// Cascade FK (projects -> steps -> runs -> messages/inbox_items/...) : un
// seul delete suffit pour le run entier. Client, globe et utilisateur
// éphémère supprimés à part.
await db.deleteFrom('projects').where('id', '=', project.id).execute()
await db.deleteFrom('clients').where('id', '=', client.id).execute()
await db.deleteFrom('globes').where('id', '=', globe.id).execute()
await db.deleteFrom('users').where('id', '=', user.id).execute()
await app.close()
await boss.stop()
await closeDb()
console.log('  fixtures DB et utilisateur éphémère supprimés')

const questionBlockedOk =
  blocked.applied && blocked.state === 'awaiting_human' && blocked.requeue === false
const inboxItemOk = itemBefore.type === 'question' && itemBefore.status === 'open'
const sseOk =
  busEvents.some((e) => e.type === 'run.state' && e.runId === runId) &&
  busEvents.some((e) => e.type === 'inbox.new' && e.id === itemBefore.id) &&
  busEvents.some((e) => e.type === 'inbox.resolved' && e.id === itemBefore.id)
const httpResolveOk = resolveRes.statusCode === 200 && itemAfter?.status === 'done'
const runResumedOk =
  jobsAfter > jobsBefore &&
  resumed.applied &&
  resumed.state === 'coding' &&
  runAfterResolve.state === 'framing' &&
  runAfterResolve.resume_state === null

const ok = questionBlockedOk && inboxItemOk && sseOk && httpResolveOk && runResumedOk

console.log()
if (ok) {
  console.log(
    '✅ Critère J6 : une question bloquante bloque le run, item + SSE constatés, résolution HTTP fait réellement repartir la boucle.',
  )
} else {
  console.error('❌ Critère J6 non satisfait :')
  if (!questionBlockedOk) console.error(`   - blocage inattendu : ${JSON.stringify(blocked)}`)
  if (!inboxItemOk) console.error('   - item d’inbox absent ou mal formé')
  if (!sseOk) console.error('   - événements SSE manquants (voir la timeline captée ci-dessus)')
  if (!httpResolveOk) console.error('   - résolution HTTP en échec')
  if (!runResumedOk) console.error('   - le run n’est pas réellement reparti')
  process.exitCode = 1
}

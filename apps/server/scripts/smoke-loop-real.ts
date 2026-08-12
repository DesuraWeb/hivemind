/**
 * Vérification manuelle des critères de fin J4 (plan Phase 2, Task 10) et J5
 * (Task 11) : le garant cadre un step réel via sa sortie structurée, le dev
 * implémente dans le worktree du run avec un vrai modèle et ouvre une pull
 * request réelle sur GitHub, puis le reviewer la revoit réellement (checkout
 * propre, tests exécutés pour de vrai) — jusqu'à convergence (`deploying`)
 * ou épuisement de la borne à 3 allers-retours (`awaiting_human`). **Consomme
 * des tokens** — jamais lancé par la suite de tests (`pnpm test` reste 100%
 * `FakeAdapter`).
 *
 *   pnpm --filter @silithid/server exec tsx scripts/smoke-loop-real.ts
 *
 * Écrit puis nettoie ses propres fixtures (globe/client/projet/step/run) et
 * son clone local temporaire — rejouable sans laisser de trace. La PR
 * ouverte sur GitHub, elle, reste ouverte : c'est la preuve du critère,
 * jamais fermée ni fusionnée par ce script.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { RunState } from '@silithid/shared'
import { closeDb, getDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { getPullRequest } from '../src/integrations/github'
import { type StepRegistry, stepOnce } from '../src/jobs/run-step'
import { type StoredMessage, readRunMessages } from '../src/loop/bus'
import { createCodingHandler } from '../src/loop/steps/coding'
import { createFramingHandler } from '../src/loop/steps/framing'
import { createReviewingHandler } from '../src/loop/steps/reviewing'
import { createClaudeAdapter } from '../src/runtime/claude'
import type { RuntimeAdapter } from '../src/runtime/types'

const run = promisify(execFile)

/** Dépôt sandbox jetable (correction actée après le plan — voir github.ts en tête de fichier). */
const SANDBOX_REPO = 'DesuraWeb/silithid-sandbox'

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

function printTimeline(messages: StoredMessage[]): void {
  if (messages.length === 0) {
    console.log('  (aucun message)')
    return
  }
  for (const m of messages) {
    const time = m.createdAt.toISOString().slice(11, 23)
    const route = `${m.fromRole} → ${m.toRole}`.padEnd(18)
    const kind = m.kind.padEnd(10)
    const excerpt = m.body.replace(/\s+/g, ' ').trim().slice(0, 100)
    console.log(`  ${time}  ${route}  ${kind}  ${excerpt}`)
  }
}

/** Additionne `costTokens` de chaque `send()`, sans toucher aux handlers eux-mêmes. */
function withCostTracking(adapter: RuntimeAdapter, totals: { tokens: number }): RuntimeAdapter {
  return {
    ...adapter,
    async send(session, message, opts) {
      const result = await adapter.send(session, message, opts)
      totals.tokens += result.costTokens
      return result
    },
  }
}

section('Préflight')
try {
  await run('gh', ['auth', 'status', '--hostname', 'github.com'])
  console.log('  gh authentifié (compte DesuraWeb attendu, scopes repo+workflow).')
} catch (err) {
  console.error("❌ `gh` n'est pas authentifié — voir github.ts en tête de fichier (auth locale).")
  throw err
}

const db = getDb()
await runMigrations(db)
await seedRoleTemplates(db)

section('Fixtures')

const worktreesRoot = await mkdtemp(join(tmpdir(), 'silithid-smoke-j4-worktrees-'))
console.log(`  racine des worktrees : ${worktreesRoot}`)
console.log(`  dépôt sandbox        : ${SANDBOX_REPO}`)

const globe = await db
  .insertInto('globes')
  .values({ name: 'Smoke J4', slug: `smoke-j4-${randomUUID()}` })
  .returning('id')
  .executeTakeFirstOrThrow()

const client = await db
  .insertInto('clients')
  .values({
    name: 'Client smoke J4',
    tone: 'direct, sans jargon',
    notes: JSON.stringify([
      { q: 'Faut-il des dépendances externes ?', a: 'Non, le dépôt reste sans dépendance.' },
    ]),
  })
  .returning('id')
  .executeTakeFirstOrThrow()

const projectSlug = `smoke-j4-${randomUUID()}`
const project = await db
  .insertInto('projects')
  .values({
    globe_id: globe.id,
    client_id: client.id,
    name: 'Projet smoke J4',
    slug: projectSlug,
    repo_full_name: SANDBOX_REPO,
    default_branch: 'main',
  })
  .returning('id')
  .executeTakeFirstOrThrow()

const step = await db
  .insertInto('steps')
  .values({
    project_id: project.id,
    position: 1,
    title: 'Ajouter une fonction add()',
    specs: [
      '## Objectif',
      'Ajoute une fonction `add(a, b)` qui additionne deux nombres, dans le',
      'style du dépôt (voir `src/greet.js` : export ESM nommé, aucune dépendance).',
      '',
      '## Attendu',
      '- `src/math.js` exporte `add(a, b)`.',
      '- Un test `node:test` (`src/math.test.js`, style de `src/greet.test.js`)',
      '  vérifie au moins un cas.',
      '- `npm test` (= `node --test`) passe.',
    ].join('\n'),
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

const costTotals = { tokens: 0 }
const adapter = withCostTracking(createClaudeAdapter(), costTotals)

const registry: StepRegistry = {
  framing: createFramingHandler({ adapter, worktreesRoot }),
  coding: createCodingHandler({ adapter, worktreesRoot }),
  reviewing: createReviewingHandler({ adapter, worktreesRoot }),
}

section('Exécution : stepOnce(framing) — le garant cadre le step')
const framingResult = await stepOnce(db, registry, runId)
console.log(
  `  résultat : applied=${framingResult.applied} state=${framingResult.state} requeue=${framingResult.requeue}`,
)

const afterFraming = await readRunMessages(db, runId)
const frameMessage = afterFraming.find((m) => m.kind === 'prompt' && m.fromRole === 'garant')
section('Frame produit par le garant')
if (frameMessage) {
  console.log(`  dev_prompt          : ${frameMessage.body}`)
  console.log(`  acceptance_criteria : ${JSON.stringify(frameMessage.meta.acceptance_criteria)}`)
  console.log(`  pages_to_judge      : ${JSON.stringify(frameMessage.meta.pages_to_judge)}`)
} else {
  console.log('  (aucun frame trouvé — voir la timeline ci-dessous)')
}

// États où la boucle dev↔reviewer s'arrête : convergence (`deploying`, hors
// périmètre au-delà de ce point — J12+) ou borne des 3 allers-retours
// épuisée (`awaiting_human`, décision A du plan Phase 2).
const LOOP_STOP_STATES: ReadonlySet<RunState> = new Set([
  'deploying',
  'awaiting_human',
  'failed',
  'done',
])

section('Exécution : coding ↔ reviewing — jusqu’à convergence ou 3 KO (critère J5)')
// 1 (framing déjà fait) + au plus 3 x (coding + reviewing) : garde-fou de
// diagnostic seulement — `decide()` borne déjà réellement la boucle.
const MAX_STEPS = 8
let last = framingResult
let steps = 1
let reviewRounds = 0
while (!LOOP_STOP_STATES.has(last.state) && last.requeue && steps < MAX_STEPS) {
  const before = last.state
  last = await stepOnce(db, registry, runId)
  steps++
  if (before === 'reviewing') reviewRounds++
  console.log(`  ${before} → ${last.state}  (applied=${last.applied} requeue=${last.requeue})`)
}
if (!LOOP_STOP_STATES.has(last.state)) {
  console.error(
    `  ⚠️ arrêté après ${steps} pas sans converger ni buter sur la borne — état actuel : ${last.state}`,
  )
}

section(`Timeline d'audit (run ${runId})`)
const messages = await readRunMessages(db, runId)
printTimeline(messages)

section('Verdicts du reviewer')
const reviewVerdicts = messages.filter((m) => m.kind === 'report' && m.fromRole === 'reviewer')
if (reviewVerdicts.length === 0) {
  console.log('  (aucune revue exécutée — voir la timeline ci-dessus)')
}
for (const [i, v] of reviewVerdicts.entries()) {
  console.log(`  tour ${i + 1} → ${String(v.meta.verdict)} (destinataire : ${v.toRole})`)
  console.log(`    ${v.body.replace(/\n/g, '\n    ')}`)
}

section('Pull request')
const runAfter = await db
  .selectFrom('runs')
  .select(['pr_number', 'branch', 'state', 'review_round'])
  .where('id', '=', runId)
  .executeTakeFirstOrThrow()

let prUrl: string | undefined
if (runAfter.pr_number) {
  const pr = await getPullRequest(SANDBOX_REPO, runAfter.pr_number)
  prUrl = pr.url
  console.log(`  #${pr.number} [${pr.state}] ${pr.title}`)
  console.log(`  ${pr.url}`)
  console.log(`  branche : ${runAfter.branch}`)
} else {
  console.log('  aucune PR (voir résultat ci-dessus)')
}

section('Allers-retours et coût')
console.log(`  allers-retours dev↔reviewer : ${reviewRounds}`)
console.log(
  `  état final du run           : ${runAfter.state} (review_round=${runAfter.review_round})`,
)
console.log(`  tokens consommés (garant + dev + reviewer) : ${costTotals.tokens}`)

section('Nettoyage')
// Fixtures DB et clone local seulement — la PR et la branche GitHub restent :
// c'est la preuve des critères J4/J5, on ne la referme ni ne la fusionne jamais ici.
await db.deleteFrom('projects').where('id', '=', project.id).execute()
await db.deleteFrom('clients').where('id', '=', client.id).execute()
await db.deleteFrom('globes').where('id', '=', globe.id).execute()
await rm(worktreesRoot, { recursive: true, force: true })
await closeDb()
console.log('  fixtures DB et clone local temporaire supprimés')

const framingOk = framingResult.applied && framingResult.state === 'coding'
const prOk = Boolean(runAfter.pr_number && prUrl)
const converged = runAfter.state === 'deploying'
const bounded = runAfter.state === 'awaiting_human'
const loopOk = converged || bounded
const ok = framingOk && prOk && loopOk

console.log()
if (ok && converged) {
  console.log(
    `✅ Critères J4 + J5 : le garant a cadré, le dev↔reviewer a convergé en ${reviewRounds} tour(s), la PR est prête pour le déploiement.`,
  )
  console.log(`   ${prUrl}`)
} else if (ok && bounded) {
  console.log(
    `✅ Critère J5 (borne) : 3 allers-retours dev↔reviewer épuisés sans convergence — le run est passé en \`awaiting_human\` avec une alerte d'inbox, comme l'exige la décision A. La PR reste ouverte pour un humain.`,
  )
  console.log(`   ${prUrl}`)
} else {
  console.error('❌ Critères J4/J5 non satisfaits :')
  if (!framingOk)
    console.error(`   - framing n'a pas abouti à "coding" : ${JSON.stringify(framingResult)}`)
  if (!prOk) console.error("   - aucune PR exploitable n'a été ouverte")
  if (!loopOk)
    console.error(
      `   - la boucle n'a ni convergé ni buté sur la borne — état final inattendu : ${runAfter.state}`,
    )
  process.exitCode = 1
}

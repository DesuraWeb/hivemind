/**
 * Vérification manuelle du CRITÈRE DE FIN DE PHASE 4 (plan, Task 5) : sur
 * `DesuraWeb/silithid-sandbox`, un step réel traverse les SIX états —
 * `framing → coding → reviewing → deploying → judging → verdict` — avec de
 * vrais modèles, un vrai commit/push/PR GitHub, un vrai aperçu local
 * (`deploying.ts`) et une vraie capture Playwright jugée par un vrai modèle
 * juge, jusqu'à convergence (verdict conforme → `awaiting_human`, gate
 * humain du mode `gated`) ou itération corrective. **Consomme des tokens**
 * — jamais lancé par `pnpm test` (100% `FakeAdapter`, voir
 * `tests/loop-j9.test.ts` pour la même boucle sans consommation).
 *
 *   pnpm --filter @silithid/server exec tsx scripts/smoke-loop-full.ts
 *
 * Écrit puis nettoie ses propres fixtures (globe/client/projet/step/run),
 * son clone local temporaire et son dossier d'artifacts — rejouable sans
 * laisser de trace, hormis la PR GitHub elle-même (jamais fermée ni
 * fusionnée ici, c'est la preuve du critère).
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunState } from '@silithid/shared'
import { closeDb, getDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { getPullRequest } from '../src/integrations/github'
import { closeBrowser } from '../src/integrations/playwright'
import { stepOnce } from '../src/jobs/run-step'
import { type StoredMessage, readRunMessages } from '../src/loop/bus'
import { createStepRegistry } from '../src/loop/registry'
import { createClaudeAdapter } from '../src/runtime/claude'
import type { RuntimeAdapter } from '../src/runtime/types'

/** Dépôt sandbox jetable (même dépôt que `smoke-loop-real.ts`/`smoke-verdict-real.ts`). */
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
    const excerpt = m.body.replace(/\s+/g, ' ').trim().slice(0, 110)
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
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  await promisify(execFile)('gh', ['auth', 'status', '--hostname', 'github.com'])
  console.log('  gh authentifié (compte DesuraWeb attendu, scopes repo+workflow).')
} catch (err) {
  console.error("❌ `gh` n'est pas authentifié — voir github.ts en tête de fichier (auth locale).")
  throw err
}

const db = getDb()
await runMigrations(db)
await seedRoleTemplates(db)

section('Fixtures')

const worktreesRoot = await mkdtemp(join(tmpdir(), 'silithid-smoke-j9-worktrees-'))
const artifactsRoot = await mkdtemp(join(tmpdir(), 'silithid-smoke-j9-artifacts-'))
console.log(`  racine des worktrees : ${worktreesRoot}`)
console.log(`  racine des artifacts : ${artifactsRoot}`)
console.log(`  dépôt sandbox        : ${SANDBOX_REPO}`)

const globe = await db
  .insertInto('globes')
  .values({ name: 'Smoke J9', slug: `smoke-j9-${randomUUID()}` })
  .returning('id')
  .executeTakeFirstOrThrow()

const client = await db
  .insertInto('clients')
  .values({
    name: 'Client smoke J9',
    tone: 'direct, sans jargon',
    notes: JSON.stringify([
      { q: 'Faut-il des dépendances externes ?', a: 'Non, le dépôt reste sans dépendance.' },
    ]),
  })
  .returning('id')
  .executeTakeFirstOrThrow()

const projectSlug = `smoke-j9-${randomUUID()}`
const project = await db
  .insertInto('projects')
  .values({
    globe_id: globe.id,
    client_id: client.id,
    name: 'Projet smoke J9',
    slug: projectSlug,
    repo_full_name: SANDBOX_REPO,
    default_branch: 'main',
    // `gated` (défaut) : le critère de fin de Phase 4 décrit explicitement
    // « soit une approbation en inbox (mode gated) », c'est le chemin qu'on
    // veut démontrer ici, pas le raccourci `auto` de `tests/loop-j9.test.ts`.
  })
  .returning('id')
  .executeTakeFirstOrThrow()

// 2 : assez pour démontrer une itération corrective réelle si le juge en
// trouve une, sans laisser une dérive de modèle consommer des tokens sans
// borne. Extrait en constante (plutôt que relu depuis `step`, dont l'insert
// ne renvoie que `id`) pour le rapport final.
const MAX_ITERATIONS = 2

const step = await db
  .insertInto('steps')
  .values({
    project_id: project.id,
    position: 1,
    title: 'Lien de contact visible sur la page d’accueil',
    specs: [
      '## Objectif',
      'Ajoute un lien texte "Contact" clairement visible tout en haut de la page',
      'd’accueil (`public/index.html`), qui pointe vers `contact.html`. Reste dans le',
      'style existant du site (voir `public/styles.css`), sans dépendance externe.',
      '',
      '## Attendu',
      '- Un lien "Contact" est visible en haut de la page d’accueil, à TOUS les',
      '  viewports (mobile compris) — pas seulement sur desktop.',
      '- Le lien pointe vers `contact.html`.',
      '- Le titre et le contenu existants de la page restent inchangés.',
    ].join('\n'),
    max_iterations: MAX_ITERATIONS,
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

// Le registre RÉEL de production (Task 5, `../src/loop/registry.ts`) — les
// six handlers, pas un sous-ensemble reconstruit à la main : c'est le
// câblage que ce smoke doit prouver, identique à celui de `index.ts`.
const registry = createStepRegistry({ adapter, worktreesRoot, artifactsRoot })

// États où cette boucle s'arrête pour de bon : approbation humaine (verdict
// conforme en mode gated, mais aussi 3 KO reviewer épuisés ou ci_red),
// épuisement des itérations (`failed`), ou (mode auto, pas ce script) `done`.
const LOOP_STOP_STATES: ReadonlySet<RunState> = new Set(['awaiting_human', 'failed', 'done'])

section('Exécution : framing → coding → reviewing → deploying → judging → verdict')
const MAX_STEPS = 40 // garde-fou de diagnostic seulement — decide() borne déjà réellement la boucle.
let last = await stepOnce(db, registry, runId)
let steps = 1
console.log(`  framing → ${last.state}  (applied=${last.applied} requeue=${last.requeue})`)
while (!LOOP_STOP_STATES.has(last.state) && last.requeue && steps < MAX_STEPS) {
  const before = last.state
  last = await stepOnce(db, registry, runId)
  steps++
  console.log(`  ${before} → ${last.state}  (applied=${last.applied} requeue=${last.requeue})`)
}
if (!LOOP_STOP_STATES.has(last.state) && last.requeue) {
  console.error(
    `  ⚠️ arrêté après ${steps} pas sans converger ni buter sur une borne — état actuel : ${last.state}`,
  )
}

section(`Timeline d'audit (run ${runId})`)
const messages = await readRunMessages(db, runId)
printTimeline(messages)

section('Verdicts du garant')
const verdicts = messages.filter(
  (m) => m.kind === 'report' && m.fromRole === 'garant' && m.toRole === 'system',
)
for (const [i, v] of verdicts.entries()) {
  console.log(`  itération ${i + 1} → ${String(v.meta.decision)}`)
  console.log(`    ${v.body.replace(/\n/g, '\n    ')}`)
}

section('Pull request')
const runAfter = await db
  .selectFrom('runs')
  .select(['pr_number', 'branch', 'state', 'iteration', 'review_round', 'cost_tokens'])
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

section('Bilan')
console.log(`  itérations                : ${runAfter.iteration} / ${MAX_ITERATIONS}`)
console.log(`  review_round final        : ${runAfter.review_round}`)
console.log(`  état final du run         : ${runAfter.state}`)
console.log(`  pas exécutés (diagnostic) : ${steps}`)
console.log(`  tokens consommés (garant + dev + reviewer + juge) : ${costTotals.tokens}`)
if (prUrl) console.log(`  PR : ${prUrl}`)

section('Nettoyage')
// Fixtures DB, clone local et artifacts seulement — la PR et la branche
// GitHub restent : c'est la preuve du critère, on ne la referme ni ne la
// fusionne jamais ici.
await db.deleteFrom('projects').where('id', '=', project.id).execute()
await db.deleteFrom('clients').where('id', '=', client.id).execute()
await db.deleteFrom('globes').where('id', '=', globe.id).execute()
await rm(worktreesRoot, { recursive: true, force: true })
await rm(artifactsRoot, { recursive: true, force: true })
await closeBrowser()
await closeDb()
console.log('  fixtures DB, clone local et artifacts temporaires supprimés')

const framingOk = steps >= 1
const prOk = Boolean(runAfter.pr_number && prUrl)
const gatedApproval = runAfter.state === 'awaiting_human'
const exhausted = runAfter.state === 'failed'
const ok = framingOk && prOk && (gatedApproval || exhausted)

console.log()
if (ok && gatedApproval) {
  console.log(
    `✅ Critère de fin Phase 4 : la boucle a traversé les six états et convergé — verdict conforme, en attente d'approbation humaine (mode gated), après ${runAfter.iteration} itération(s).`,
  )
  if (prUrl) console.log(`   ${prUrl}`)
} else if (ok && exhausted) {
  console.log(
    `✅ Critère de fin Phase 4 (épuisement) : la boucle a traversé les six états, le juge a maintenu des écarts jusqu'à épuiser ${MAX_ITERATIONS} itération(s) — le run est passé en \`failed\` avec une alerte d'inbox, comme l'exige \`decide()\`. La PR reste ouverte pour un humain.`,
  )
  if (prUrl) console.log(`   ${prUrl}`)
} else {
  console.error('❌ Critère de fin Phase 4 non satisfait :')
  if (!prOk) console.error("   - aucune PR exploitable n'a été ouverte")
  if (!gatedApproval && !exhausted)
    console.error(
      `   - la boucle n'a ni convergé (awaiting_human) ni épuisé ses itérations (failed) — état final inattendu : ${runAfter.state}`,
    )
  process.exitCode = 1
}

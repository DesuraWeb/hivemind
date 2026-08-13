/**
 * Vérification manuelle de la Task 4 (Phase 4) : le garant arbitre-t-il
 * réellement, ou bloque-t-il systématiquement dès qu'un écart apparaît ?
 * **Consomme des tokens** — jamais lancé par `pnpm test` (100% `FakeAdapter`,
 * voir `tests/verdict.test.ts`).
 *
 * Trois scénarios, chacun avec un vrai modèle (`createClaudeAdapter`) :
 *
 *   A. Un vrai rapport de juge (produit par `createJudgingHandler`, comme
 *      `scripts/smoke-judge-real.ts`) sur la même page défectueuse — deux
 *      défauts réels par rapport aux critères. Iteration 1/2 (pas la
 *      dernière) : le garant devrait rendre "ecarts" avec un
 *      `dev_prompt_correctif`.
 *   B. LE MÊME rapport de juge, mais iteration 2/2 (la dernière). Vérifie le
 *      point 3 du plan : le garant doit-il encore produire un correctif qui
 *      ne tournera jamais, ou arbitrer ?
 *   C. Un rapport de juge fabriqué à la main : conformités correctes, UN
 *      SEUL écart mineur explicitement hors des critères d'acceptation
 *      listés (bouton légèrement décalé, jamais mentionné dans les
 *      critères). Iteration 1/4. Vérifie le point 2 du plan : un écart
 *      cosmétique hors critère ne doit pas, à lui seul, empêcher "conforme".
 *
 *   pnpm --filter @silithid/server exec tsx scripts/smoke-verdict-real.ts
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordCapturedPages } from '../src/artifacts/store'
import { closeDb, getDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { capturePages, closeBrowser } from '../src/integrations/playwright'
import { appendMessage, readRunMessages } from '../src/loop/bus'
import { createJudgingHandler } from '../src/loop/steps/judging'
import { createVerdictHandler } from '../src/loop/steps/verdict'
import { createClaudeAdapter } from '../src/runtime/claude'
import type { Verdict } from '../src/runtime/structured'

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

const PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: sans-serif; margin: 0; padding: 24px; }
      .cta { background: #2b6cb0; color: white; padding: 12px 20px; border: none; font-size: 16px; }
      @media (max-width: 500px) {
        .cta { display: none; }
      }
    </style>
  </head>
  <body>
    <h1>Bienvenue chez Silithid</h1>
    <p>Silithid orchestre des agents pour livrer vos projets.</p>
    <button class="cta">Démarrer un projet</button>
  </body>
</html>`

async function startStaticServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

const db = getDb()
await runMigrations(db)
await seedRoleTemplates(db)

const adapter = createClaudeAdapter()

section('Fixtures communes')
const globe = await db
  .insertInto('globes')
  .values({ name: 'Smoke Verdict', slug: `smoke-verdict-${randomUUID()}` })
  .returning('id')
  .executeTakeFirstOrThrow()
const project = await db
  .insertInto('projects')
  .values({
    globe_id: globe.id,
    name: 'Projet Smoke Verdict',
    slug: `projet-smoke-verdict-${randomUUID()}`,
    repo_full_name: 'silithid/sandbox-smoke-verdict',
  })
  .returning('id')
  .executeTakeFirstOrThrow()
console.log(`  globe=${globe.id} projet=${project.id}`)

const acceptanceCriteria = [
  'Le titre affiche exactement "Bienvenue chez Silithid".',
  'Un lien vers une page de contact est visible sur la page.',
  'Le bouton d’action principal ("Démarrer un projet") est visible à tous les viewports, y compris mobile.',
]

async function seedFrameAndReviewer(runId: string): Promise<void> {
  await appendMessage(db, {
    runId,
    fromRole: 'garant',
    toRole: 'dev',
    kind: 'prompt',
    body: 'Implémente la page d’accueil de Silithid : titre, lien de contact, bouton d’action principal toujours visible.',
    meta: { acceptance_criteria: acceptanceCriteria, pages_to_judge: ['/'] },
  })
  await appendMessage(db, {
    runId,
    fromRole: 'reviewer',
    toRole: 'garant',
    kind: 'report',
    body: 'OK — la PR satisfait les critères d’acceptation vérifiés (tests exécutés réellement).',
    meta: { verdict: 'OK', points: [] },
  })
}

function printVerdict(label: string, verdict: Verdict): void {
  console.log(`  ${label} decision=${verdict.decision}`)
  for (const e of verdict.ecarts) {
    console.log(`    - [${e.severite}] ${e.description} — ${e.correctif}`)
  }
  if (verdict.dev_prompt_correctif) {
    console.log(`    dev_prompt_correctif : ${verdict.dev_prompt_correctif}`)
  } else {
    console.log('    dev_prompt_correctif : (absent)')
  }
}

async function latestVerdictMeta(runId: string): Promise<Verdict | undefined> {
  const messages = await readRunMessages(db, runId)
  const audit = [...messages]
    .reverse()
    .find((m) => m.kind === 'report' && m.fromRole === 'garant' && m.toRole === 'system')
  if (!audit) return undefined
  return {
    decision: audit.meta.decision as Verdict['decision'],
    ecarts: audit.meta.ecarts as Verdict['ecarts'],
  }
}

// ─────────────────────────────────────────────────────────────────────────
section('Scénarios A/B — vrai rapport de juge (Playwright + vrai modèle juge)')

const artifactsRoot = await mkdtemp(join(tmpdir(), 'silithid-smoke-verdict-artifacts-'))
const site = await startStaticServer()

const stepAB = await db
  .insertInto('steps')
  .values({
    project_id: project.id,
    position: 1,
    title: 'Page d’accueil (A/B)',
    specs: '## Juger',
    max_iterations: 2,
  })
  .returning('id')
  .executeTakeFirstOrThrow()
const runAB = await db
  .insertInto('runs')
  .values({ step_id: stepAB.id, state: 'judging', iteration: 1 })
  .returning('id')
  .executeTakeFirstOrThrow()
const runIdAB = runAB.id
console.log(`  run=${runIdAB} (step max_iterations=2)`)

await seedFrameAndReviewer(runIdAB)

const outDir = join(artifactsRoot, runIdAB)
const captures = await capturePages(site.url, ['/'], outDir)
await recordCapturedPages(db, runIdAB, artifactsRoot, captures)
await site.close()
console.log(`  ${captures.length} captures réelles écrites`)

const judgingHandler = createJudgingHandler({ adapter, artifactsRoot })
const judgeEvent = await judgingHandler(db, runIdAB)
console.log(`  jugement : ${JSON.stringify(judgeEvent)}`)

const judgeMessages = await readRunMessages(db, runIdAB)
const judgeReport = judgeMessages.find((m) => m.kind === 'report' && m.fromRole === 'judge')
if (judgeReport) {
  console.log('\n  Rapport du juge (réel) :')
  console.log(`  ${judgeReport.body.replace(/\n/g, '\n  ')}`)
}

section('Scénario A — iteration 1/2 (pas la dernière)')
const verdictHandler = createVerdictHandler({ adapter })
// worktree_path : un vrai répertoire, requis par le SDK réel (contrairement
// au FakeAdapter des tests, qui ignore `cwd`).
const worktreeAB = await mkdtemp(join(tmpdir(), 'silithid-smoke-verdict-worktree-'))
await db.updateTable('runs').set({ worktree_path: worktreeAB }).where('id', '=', runIdAB).execute()

const verdictA = await verdictHandler(db, runIdAB)
console.log(`  événement : ${JSON.stringify(verdictA)}`)
const metaA = await latestVerdictMeta(runIdAB)
if (metaA) printVerdict('A', metaA)

section('Scénario B — MÊME rapport de juge, iteration 2/2 (la dernière)')
await db.updateTable('runs').set({ iteration: 2 }).where('id', '=', runIdAB).execute()
const verdictB = await verdictHandler(db, runIdAB)
console.log(`  événement : ${JSON.stringify(verdictB)}`)
const metaB = await latestVerdictMeta(runIdAB)
if (metaB) printVerdict('B', metaB)

// ─────────────────────────────────────────────────────────────────────────
section('Scénario C — écart mineur hors critères d’acceptation (rapport fabriqué)')

const stepC = await db
  .insertInto('steps')
  .values({
    project_id: project.id,
    position: 2,
    title: 'Page mineur hors critères (C)',
    specs: '## Juger',
    max_iterations: 4,
  })
  .returning('id')
  .executeTakeFirstOrThrow()
const runC = await db
  .insertInto('runs')
  .values({ step_id: stepC.id, state: 'verdict', iteration: 1 })
  .returning('id')
  .executeTakeFirstOrThrow()
const runIdC = runC.id
const worktreeC = await mkdtemp(join(tmpdir(), 'silithid-smoke-verdict-worktree-c-'))
await db.updateTable('runs').set({ worktree_path: worktreeC }).where('id', '=', runIdC).execute()
console.log(`  run=${runIdC} (step max_iterations=4, iteration=1)`)

await seedFrameAndReviewer(runIdC)
await appendMessage(db, {
  runId: runIdC,
  fromRole: 'judge',
  toRole: 'garant',
  kind: 'report',
  body: [
    '3 conformité(s) constatée(s), 1 écart(s).',
    '',
    'Conformités :',
    '- le titre affiche bien "Bienvenue chez Silithid"',
    '- un lien de contact est visible et fonctionnel',
    '- le bouton "Démarrer un projet" reste visible à tous les viewports',
    '',
    'Écarts :',
    '- [mineur] index (desktop) — le bouton "Démarrer un projet" a un padding ' +
      'légèrement différent (18px au lieu de 20px) des autres boutons du site ; ' +
      'ce point esthétique n’est couvert par aucun des critères d’acceptation ' +
      'listés pour ce step. (réf. index-desktop.png)',
  ].join('\n'),
  meta: {
    conformites: [
      'le titre affiche bien "Bienvenue chez Silithid"',
      'un lien de contact est visible et fonctionnel',
      'le bouton "Démarrer un projet" reste visible à tous les viewports',
    ],
    ecarts: [
      {
        severite: 'mineur',
        page: 'index',
        viewport: 'desktop',
        description:
          'le bouton a un padding légèrement différent (18px au lieu de 20px), hors critères',
        screenshot_ref: 'index-desktop.png',
      },
    ],
  },
})

const verdictC = await verdictHandler(db, runIdC)
console.log(`  événement : ${JSON.stringify(verdictC)}`)
const metaC = await latestVerdictMeta(runIdC)
if (metaC) printVerdict('C', metaC)

// ─────────────────────────────────────────────────────────────────────────
section('Nettoyage')
await db.deleteFrom('projects').where('id', '=', project.id).execute()
await db.deleteFrom('globes').where('id', '=', globe.id).execute()
await closeBrowser()
await rm(artifactsRoot, { recursive: true, force: true })
await rm(worktreeAB, { recursive: true, force: true })
await rm(worktreeC, { recursive: true, force: true })
await closeDb()
console.log('  fixtures DB et répertoires temporaires supprimés')

// ─────────────────────────────────────────────────────────────────────────
section('Bilan')
console.log(`  A (iteration 1/2, écarts réels)      : ${verdictA.type}`)
console.log(`  B (iteration 2/2, MÊMES écarts réels): ${verdictB.type}`)
console.log(`  C (mineur hors critères, iteration 1/4): ${verdictC.type}`)

const cConforme = verdictC.type === 'verdict_conforme'
if (!cConforme) {
  console.error(
    '\n⚠️  Scénario C : le garant a rendu "ecarts" pour un écart mineur explicitement hors ' +
      'critères d’acceptation — le prompt (garant.md, section "Verdict") est probablement à ' +
      'ajuster : la règle "un écart cosmétique non couvert par un critère n’est pas un écart" ' +
      'n’est pas suivie de façon fiable.',
  )
  process.exitCode = 1
} else {
  console.log('\n✅ Scénario C : le garant n’a pas bloqué sur un écart mineur hors critères.')
}

if (metaB?.decision === 'ecarts' && !metaB.dev_prompt_correctif) {
  console.log(
    '\nℹ️  Scénario B : à la dernière itération, le garant a maintenu "ecarts" SANS produire de ' +
      'dev_prompt_correctif — cohérent avec l’arbitrage attendu (un écart bloquant réel doit ' +
      'remonter en échec, pas être masqué, mais aucun correctif inutile n’est produit).',
  )
} else if (metaB?.decision === 'ecarts' && metaB.dev_prompt_correctif) {
  console.log(
    '\nℹ️  Scénario B : à la dernière itération, le garant a produit un dev_prompt_correctif ' +
      'alors qu’aucun tour suivant ne l’exécutera jamais — à examiner : le préambule (verdict.ts, ' +
      'section "Itération") ou garant.md sont peut-être à renforcer sur ce point précis.',
  )
} else if (metaB?.decision === 'conforme') {
  console.log(
    '\nℹ️  Scénario B : à la dernière itération, le garant a arbitré vers "conforme" plutôt que ' +
      'de produire un correctif voué à ne jamais tourner.',
  )
}

/**
 * Vérification manuelle de la Task 3 (Phase 4) : le juge visuel voit-il
 * RÉELLEMENT le contenu des captures, ou décrit-il le DOM/le prompt sans
 * jamais avoir regardé les PNG ? **Consomme des tokens** — jamais lancé par
 * `pnpm test` (100% `FakeAdapter`, voir `tests/judging.test.ts`).
 *
 * Méthode : une page locale, statique et volontairement défectueuse par
 * rapport à ses propres critères d'acceptation —
 *   1. le titre "Bienvenue chez Silithid" est bien présent (conformité attendue) ;
 *   2. un lien de contact visible est ATTENDU mais absent du HTML (écart bloquant attendu) ;
 *   3. le bouton d'action principal est masqué en CSS uniquement sous 500px de large
 *      (écart mobile-only attendu — un juge qui ne regarde QUE le DOM, sans
 *      appliquer le CSS responsive au bon viewport, ne peut pas le détecter).
 * Un juge qui ne fait que lire le prompt ou le DOM textuel (sans jamais ouvrir
 * les PNG avec `Read`) ne peut pas distinguer ce cas du cas "bouton visible
 * partout" — la seule façon de le repérer est de VOIR la capture mobile.
 *
 *   pnpm --filter @silithid/server exec tsx scripts/smoke-judge-real.ts
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
import { createClaudeAdapter } from '../src/runtime/claude'

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
      /* Défaut volontaire : le bouton d'action disparaît sous 500px — le
         viewport mobile (390px) le voit disparaître, tablette (768px) et
         desktop (1440px) ne sont pas concernés. */
      @media (max-width: 500px) {
        .cta { display: none; }
      }
    </style>
  </head>
  <body>
    <h1>Bienvenue chez Silithid</h1>
    <p>Silithid orchestre des agents pour livrer vos projets.</p>
    <button class="cta">Démarrer un projet</button>
    <!-- Pas de lien de contact ici : défaut volontaire n°2. -->
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

section('Fixtures')
const globe = await db
  .insertInto('globes')
  .values({ name: 'Smoke Judge', slug: `smoke-judge-${randomUUID()}` })
  .returning('id')
  .executeTakeFirstOrThrow()
const project = await db
  .insertInto('projects')
  .values({
    globe_id: globe.id,
    name: 'Projet Smoke Judge',
    slug: `projet-smoke-judge-${randomUUID()}`,
    repo_full_name: 'silithid/sandbox-smoke-judge',
  })
  .returning('id')
  .executeTakeFirstOrThrow()
const step = await db
  .insertInto('steps')
  .values({ project_id: project.id, position: 1, title: 'Page d’accueil', specs: '## Juger' })
  .returning('id')
  .executeTakeFirstOrThrow()
const runRow = await db
  .insertInto('runs')
  .values({ step_id: step.id, state: 'judging' })
  .returning('id')
  .executeTakeFirstOrThrow()
const runId = runRow.id
console.log(`  run=${runId}`)

const acceptanceCriteria = [
  'Le titre affiche exactement "Bienvenue chez Silithid".',
  'Un lien vers une page de contact est visible sur la page.',
  'Le bouton d’action principal ("Démarrer un projet") est visible à tous les viewports, y compris mobile.',
]
await appendMessage(db, {
  runId,
  fromRole: 'garant',
  toRole: 'dev',
  kind: 'prompt',
  body: 'Implémente la page d’accueil de Silithid : titre, lien de contact, bouton d’action principal toujours visible.',
  meta: { acceptance_criteria: acceptanceCriteria, pages_to_judge: ['/'] },
})

section('Capture réelle (Playwright, page locale statique)')
const artifactsRoot = await mkdtemp(join(tmpdir(), 'silithid-smoke-judge-artifacts-'))
const site = await startStaticServer()
const outDir = join(artifactsRoot, runId)
const captures = await capturePages(site.url, ['/'], outDir)
await recordCapturedPages(db, runId, artifactsRoot, captures)
await site.close()
console.log(`  ${captures.length} captures écrites dans ${outDir}`)
for (const c of captures) {
  console.log(`    - ${c.viewport} : ${c.screenshotPath}`)
}

section('Jugement réel (vrai modèle, consomme des tokens)')
const adapter = createClaudeAdapter()
const handler = createJudgingHandler({ adapter, artifactsRoot })
const event = await handler(db, runId)
console.log(`  événement produit : ${JSON.stringify(event)}`)

section('Rapport du juge (passation juge→garant)')
const messages = await readRunMessages(db, runId)
const report = messages.find((m) => m.kind === 'report' && m.fromRole === 'judge')
if (report) {
  console.log(report.body)
  console.log('\n  meta brute :')
  console.log(JSON.stringify(report.meta, null, 2))
} else {
  console.error('  ❌ aucune passation juge→garant trouvée')
}

section('Nettoyage')
await db.deleteFrom('projects').where('id', '=', project.id).execute()
await db.deleteFrom('globes').where('id', '=', globe.id).execute()
await closeBrowser()
await rm(artifactsRoot, { recursive: true, force: true })
await closeDb()
console.log('  fixtures DB et captures temporaires supprimées')

const gotContactEcart = Boolean(
  (report?.meta.ecarts as { description: string }[] | undefined)?.some((e) =>
    /contact/i.test(e.description),
  ),
)
const gotMobileButtonEcart = Boolean(
  (report?.meta.ecarts as { viewport: string; description: string }[] | undefined)?.some(
    (e) => e.viewport === 'mobile' && /bouton|cta|action/i.test(e.description),
  ),
)

console.log()
if (event.type === 'judge_report' && gotContactEcart && gotMobileButtonEcart) {
  console.log(
    '✅ Le juge a repéré le lien de contact absent ET le bouton masqué spécifiquement au ' +
      "viewport mobile — la seule façon d'obtenir ce second constat est d'avoir réellement " +
      'ouvert la capture mobile, pas seulement lu le DOM ou le prompt.',
  )
} else {
  console.error('❌ Le juge n’a pas repéré les deux défauts attendus — voir le rapport ci-dessus.')
  process.exitCode = 1
}

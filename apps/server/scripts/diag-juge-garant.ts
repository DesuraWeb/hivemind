/**
 * Diagnostic ciblé : le juge juge-t-il CONTRE les critères d'acceptation, et le
 * garant arbitre-t-il honnêtement ?
 *
 * Constat du run de fin de Phase 4 : le juge a rendu 0 conformité et 6 écarts
 * dont un bloquant, et le garant a répondu `conforme` avec une liste d'écarts
 * vide. La plomberie est vérifiée correcte des deux côtés — c'est donc un
 * problème de jugement, impossible à trancher sur une page de démonstration
 * dont personne ne sait ce qu'elle devrait contenir.
 *
 * Ce script contrôle la vérité terrain. Trois critères d'acceptation explicites,
 * dont on sait par construction lesquels sont satisfaits :
 *
 *   1. Lien « Contact » dans le pied de page ........ SATISFAIT
 *   2. Titre de page « Nos services » ............... SATISFAIT
 *   3. Bouton « Demander un devis » visible aux 3 viewports .. VIOLÉ en mobile
 *      (masqué par une media query sous 500px, donc invisible SEULEMENT là)
 *
 * Attendu d'un juge correct : 2 conformités, 1 écart au viewport mobile.
 * Attendu d'un garant correct : `ecarts`, l'écart étant dans les critères.
 *
 * Il n'amorce que `judging` puis `verdict` : le dev et le reviewer coûtent
 * l'essentiel des tokens d'une boucle complète et n'ont rien à voir avec le
 * doute qu'on lève ici.
 *
 *   pnpm --filter @silithid/server exec tsx scripts/diag-juge-garant.ts
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordCapturedPages } from '../src/artifacts/store'
import { closeDb, getDb } from '../src/db/client'
import { loadEnv } from '../src/env'
import { capturePages, closeBrowser } from '../src/integrations/playwright'
import { startStaticPreview } from '../src/integrations/preview'
import { appendMessage, readRunMessages } from '../src/loop/bus'
import { createJudgingHandler } from '../src/loop/steps/judging'
import { createVerdictHandler } from '../src/loop/steps/verdict'
import { createClaudeAdapter } from '../src/runtime/claude'

const PAGE = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nos services</title>
    <style>
      body { margin: 0; padding: 32px; background: #101418; color: #e8eaed;
             font: 16px/1.6 system-ui, sans-serif; }
      h1 { font-size: 30px; margin: 0 0 16px; }
      .devis { display: inline-block; margin: 24px 0; padding: 12px 22px;
               background: #7fd9cf; color: #101418; border-radius: 8px;
               font-weight: 600; text-decoration: none; }
      /* Le bouton disparaît sous 500px : c'est l'écart que le juge doit voir,
         et UNIQUEMENT au viewport mobile. */
      @media (max-width: 500px) { .devis { display: none; } }
      footer { margin-top: 48px; color: #9aa0a6; font-size: 14px; }
      footer a { color: #7fd9cf; }
    </style>
  </head>
  <body>
    <h1>Nos services</h1>
    <p>Accompagnement, développement et maintenance de sites sur mesure.</p>
    <a class="devis" href="#devis">Demander un devis</a>
    <footer><a href="/contact">Contact</a></footer>
  </body>
</html>`

const CRITERIA = [
  'Un lien « Contact » est présent dans le pied de page.',
  'Le titre de la page est « Nos services ».',
  'Le bouton « Demander un devis » est visible sur les trois viewports.',
]

const env = loadEnv()
const db = getDb()
const adapter = createClaudeAdapter()

const siteDir = await mkdtemp(join(tmpdir(), 'silithid-diag-site-'))
const artifactsRoot = await mkdtemp(join(tmpdir(), 'silithid-diag-artifacts-'))
await writeFile(join(siteDir, 'index.html'), PAGE, 'utf8')

const globe = await db.selectFrom('globes').select('id').executeTakeFirstOrThrow()
const project = await db
  .insertInto('projects')
  .values({
    globe_id: globe.id,
    name: 'Diagnostic juge',
    slug: `diag-${Date.now()}`,
    repo_full_name: 'DesuraWeb/silithid-sandbox',
    stack: 'statique',
  })
  .returning('id')
  .executeTakeFirstOrThrow()
const step = await db
  .insertInto('steps')
  .values({
    project_id: project.id,
    position: 1,
    title: 'Page services',
    specs: '## Specs\nUne page de services avec un bouton de devis et un lien de contact.',
    max_iterations: 2,
  })
  .returning('id')
  .executeTakeFirstOrThrow()
const run = await db
  .insertInto('runs')
  .values({ step_id: step.id, state: 'judging', worktree_path: siteDir })
  .returning('id')
  .executeTakeFirstOrThrow()

// Le cadrage que le juge et le garant liront : critères explicites, portée nette.
await appendMessage(db, {
  runId: run.id,
  fromRole: 'garant',
  toRole: 'dev',
  kind: 'prompt',
  body: 'Livrer la page « Nos services » : titre, bouton de devis, lien de contact.',
  meta: { acceptance_criteria: CRITERIA, pages_to_judge: ['/'] },
})
await appendMessage(db, {
  runId: run.id,
  fromRole: 'reviewer',
  toRole: 'garant',
  kind: 'report',
  body: 'OK — le code correspond au cadrage, les critères sont couverts côté source.',
})

const preview = await startStaticPreview(siteDir)
try {
  const captures = await capturePages(preview.url, ['/'], join(artifactsRoot, run.id))
  await recordCapturedPages(db, run.id, artifactsRoot, captures)
} finally {
  await preview.close()
}

console.log(`── Vérité terrain ${'─'.repeat(48)}`)
console.log('  critère 1 (lien Contact) ................ SATISFAIT')
console.log('  critère 2 (titre « Nos services ») ...... SATISFAIT')
console.log('  critère 3 (bouton visible 3 viewports) .. VIOLÉ en mobile uniquement')
console.log('  attendu : 2 conformités · 1 écart mobile · verdict « ecarts »\n')

const judging = createJudgingHandler({ adapter, artifactsRoot })
console.log(`── Le juge ${'─'.repeat(55)}`)
const judgeEvent = await judging(db, run.id)
console.log(`  évènement émis : ${judgeEvent.type}`)

const afterJudge = await readRunMessages(db, run.id)
const judgeMsg = afterJudge.reverse().find((m) => m.fromRole === 'judge')
console.log(`\n${judgeMsg?.body ?? '(aucun rapport)'}\n`)

await db.updateTable('runs').set({ state: 'verdict' }).where('id', '=', run.id).execute()

const verdict = createVerdictHandler({ adapter })
console.log(`── Le garant ${'─'.repeat(53)}`)
const verdictEvent = await verdict(db, run.id)
console.log(`  évènement émis : ${verdictEvent.type}`)

const afterVerdict = await readRunMessages(db, run.id)
const verdictMsg = afterVerdict
  .reverse()
  .find((m) => m.fromRole === 'garant' && m.kind !== 'prompt')
console.log(`\n${verdictMsg?.body ?? '(aucun verdict)'}\n`)
if (verdictMsg?.meta) console.log(`  meta : ${JSON.stringify(verdictMsg.meta)}\n`)

console.log(`── Verdict du diagnostic ${'─'.repeat(41)}`)
console.log(`  le juge a émis      : ${judgeEvent.type}`)
console.log(`  le garant a émis    : ${verdictEvent.type}`)
console.log('  À confronter à la vérité terrain ci-dessus.')

await db.deleteFrom('projects').where('id', '=', project.id).execute()
await rm(siteDir, { recursive: true, force: true })
await rm(artifactsRoot, { recursive: true, force: true })
await closeBrowser()
await closeDb()
console.log(`\n(fixtures nettoyées · ARTIFACTS_ROOT du projet inchangé : ${env.ARTIFACTS_ROOT})`)

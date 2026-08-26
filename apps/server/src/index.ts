import { buildApp } from './app'
import { createSecretBox } from './crypto/secrets'
import { getDb } from './db/client'
import { DEFAULT_ALERT_EMAIL, loadEnv } from './env'
import { createLazyGmailDrafts } from './integrations/gmail'
import { createMailer } from './integrations/mailer'
import { closeBrowser } from './integrations/playwright'
import { createBoss, startBoss } from './jobs/boss'
import { createStepRegistry } from './loop/registry'
import { createSshExecutor } from './ops/executor'
import { createRuntimeAdapter } from './runtime/index'
import { createSettingsStore } from './settings/store'

const env = loadEnv()
const db = getDb()

// Construits une seule fois et partagés entre les routes HTTP et les workers
// pg-boss (voir le commentaire sur `AppDeps.adapter` dans app.ts).
const adapter = await createRuntimeAdapter(env)
const mailer = createMailer(env)
const alertTo = env.ALERT_EMAIL_TO ?? DEFAULT_ALERT_EMAIL

// Construit avant `buildApp` : `POST /api/inbox/:id/resolve` (Task 4) a
// besoin de la même instance pour ré-enfiler `run.step` — `createBoss` ne
// fait que construire l'objet, `startBoss` (plus bas) le démarre.
const boss = createBoss(env)

// Le store est sans état (il ne fait que lire/écrire la table `settings`) :
// celui-ci et celui construit par `buildApp` ne peuvent pas diverger.
const settings = createSettingsStore(db, await createSecretBox(env.MASTER_KEY))

const app = await buildApp({ db, adapter, mailer, boss })
boss.on('error', (err) => app.log.error(err, 'pg-boss'))

// Câblage du registre réel (Task 5, Phase 4, critère de fin) : jusqu'ici
// `stepRegistry` était omis, donc vide (`registerRunStepWorker`, valeur par
// défaut `{}`) — aucun run ne pouvait avancer tout seul en production, seuls
// les tests et les scripts de smoke le remplissaient. `./loop/registry.ts`
// documente pourquoi ces six entrées suffisent (les cinq autres états de
// `RunState` n'ont structurellement pas besoin de handler).
await startBoss(boss, {
  db,
  adapter,
  mailer,
  alertTo,
  settings,
  loopConcurrency: env.LOOP_CONCURRENCY,
  // De quoi rédiger, pour le worker `communicant.draft` : la surface de
  // brouillon, jamais celle d'envoi.
  gmailDrafts: createLazyGmailDrafts(settings),
  // De quoi exécuter un changement approuvé sur un serveur. L'accès est relu
  // dans le coffre à chaque appel, avec la portée du serveur visé.
  opsExecutor: createSshExecutor(settings),
  stepRegistry: createStepRegistry({
    adapter,
    worktreesRoot: env.WORKTREES_ROOT,
    artifactsRoot: env.ARTIFACTS_ROOT,
    // De quoi résoudre la cible configurée d'un projet. Sans ces deux-là, tout
    // déploiement retombe sur l'aperçu local, quelle que soit la configuration
    // en base.
    db,
    settings,
  }),
})

await app.listen({ port: env.PORT, host: env.HOST })

let arretEnCours = false

async function shutdown(): Promise<void> {
  // Un second signal pendant l'arrêt ne relance pas la séquence : systemd
  // envoie SIGTERM puis SIGKILL, et un `boss.stop()` concurrent laisserait des
  // workers dans un état indéterminé.
  if (arretEnCours) return
  arretEnCours = true

  // `boss.stop()` rend la main AVANT que les workers en cours ne soient
  // drainés : l'arrêt effectif est signalé par l'évènement `stopped`. Sans
  // cette attente, un SIGTERM au milieu d'un step tue l'agent en plein
  // travail — le run reste dans un état actif sans personne pour l'avancer.
  // Le même défaut avait été trouvé côté tests (`tests/stop-boss.ts`).
  const draine = new Promise<void>((resolve) => {
    boss.once('stopped', () => resolve())
  })
  await boss.stop({ graceful: true })
  await draine
  // Ferme le navigateur Chromium partagé (Task 1, Phase 4) : une fuite de
  // Chromium coûte bien plus cher qu'une fuite de connexion, jamais laissée
  // au ramasse-miettes du process.
  await closeBrowser()
  await app.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

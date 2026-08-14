// Base de TEST, obligatoirement. Sur la base de dev, le serveur `pnpm dev`
// qui tourne consomme les jobs avec le VRAI registre — on vérifierait le
// câblage de quelqu'un d'autre, avec de vrais clones git à la clé.
// (Constaté : le handler `deploying` réel a répondu « aucun worktree
// enregistré » à un run de ce script.)
process.env.NODE_ENV = 'test'

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import type { LoopEvent } from '../src/domain/run-state'
import { databaseUrl, loadEnv } from '../src/env'
import { createBoss, startBoss } from '../src/jobs/boss'
import type { StepRegistry } from '../src/jobs/run-step'
import { createFakeAdapter } from '../src/runtime/fake'
import { stopBoss } from '../tests/stop-boss'

/**
 * VÉRIFICATION MANUELLE de la chaîne complète :
 *
 *   requête HTTP → pg-boss → **le vrai worker** → handler → machine à états
 *   → ré-enfilage → état suivant
 *
 * Tous les tests de boucle existants (`loop-j9`, `review-loop`) appellent
 * `stepOnce` directement, avec le commentaire « comme le ferait le worker ».
 * C'est utile pour la logique, mais ça ne prouve rien du câblage : que le
 * worker soit réellement enregistré, que la forme des données de job
 * corresponde, que le ré-enfilage parte. Un run qui reste immobile parce que
 * personne ne le consomme est exactement le genre de panne qui ne se voit
 * qu'en production, et qui ressemble à « ça ne fait rien ».
 *
 * Aucun token : les handlers sont scriptés, ils ne parlent à aucun modèle.
 * C'est le CÂBLAGE qu'on vérifie ici, pas le jugement des agents — celui-là
 * est couvert par `scripts/diag-juge-garant.ts`, avec de vrais modèles.
 *
 *   pnpm --filter @silithid/server exec tsx scripts/verify-chain.ts
 *
 * ## Pourquoi un script et pas un test
 *
 * Il PASSE, systématiquement, lancé seul. Il échoue dans `pnpm test` pour une
 * raison qui n'a rien à voir avec le code vérifié : les workers pg-boss
 * fuient d'un fichier de test à l'autre. Un worker survit à l'`afterAll` de
 * son fichier — malgré l'attente de l'évènement `stopped` — consomme les jobs
 * du fichier suivant et les fait échouer contre un schéma `public` déjà
 * détruit. Diagnostiqué en lisant `pgboss.job.output`, jamais visible côté
 * test : le run reste simplement immobile.
 *
 * Deux correctifs ont réduit le problème sans le clore (drainage attendu à
 * l'arrêt, purge des jobs à l'entrée ET à la sortie de chaque fichier). Plutôt
 * que de laisser une suite rouge sur un défaut de harnais, la vérification
 * rejoint `smoke-loop-full.ts` et `diag-juge-garant.ts` : lancée à la main,
 * verte à chaque fois. Le vrai correctif serait une base par fichier de test.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const boss: PgBoss = createBoss(env)

/** Les six états, scriptés pour avancer sans rien appeler d'externe. */
const registry: StepRegistry = {
  framing: async () => ({ type: 'frame_ready' }) satisfies LoopEvent,
  coding: async () => ({ type: 'pr_opened', prNumber: 42 }) satisfies LoopEvent,
  reviewing: async () => ({ type: 'review_ok' }) satisfies LoopEvent,
  deploying: async () => ({ type: 'ci_green' }) satisfies LoopEvent,
  judging: async () => ({ type: 'judge_report' }) satisfies LoopEvent,
  verdict: async () => ({ type: 'verdict_conforme' }) satisfies LoopEvent,
}

const app = await buildApp({ db, boss, adapter: createFakeAdapter() })
let cookie = ''

/** Assertion minimale : ce script n'a pas de harnais, il n'en a pas besoin. */
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) throw new Error(`ÉCHEC · ${label}${detail ? ` · ${detail}` : ''}`)
  console.log(`  ok · ${label}`)
}

async function setup(): Promise<void> {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  // Et pg-boss AUSSI : `drop schema public` ne le touche pas, et les jobs des
  // exécutions précédentes s'y accumulent. Mesuré : au-delà de quelques
  // dizaines de jobs, le worker n'en consomme plus un seul et le run reste
  // immobile — sans erreur visible. C'est le défaut d'isolation qui a fait
  // sortir cette vérification de la suite de tests.
  await sql`drop schema if exists pgboss cascade`.execute(db)
  await runMigrations(db)
  await createUser(db, 'florian', 'motdepasse-de-test')

  // Le VRAI démarrage, celui d'`index.ts` : queues, worker `run.step`, crons.
  await startBoss(boss, {
    db,
    adapter: createFakeAdapter(),
    mailer: { send: async () => {} } as never,
    alertTo: 'alerts@exemple.test',
    settings: { get: async () => undefined } as never,
    stepRegistry: registry,
  })
  await app.ready()

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  cookie = login.cookies.find((c) => c.name === 'hm_session')?.value as string
}

async function teardown(): Promise<void> {
  await app.close()
  await stopBoss(boss)
  await db.destroy()
}

async function seedStep(): Promise<string> {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe E2E', slug: `globe-e2e-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Projet E2E',
      slug: `projet-e2e-${randomUUID()}`,
      repo_full_name: 'DesuraWeb/silithid-sandbox',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'Step E2E', specs: '## Specs' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return step.id
}

/** Attend qu'un run atteigne l'un des états attendus, ou abandonne. */
async function waitForState(runId: string, expected: string[], timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const row = await db
      .selectFrom('runs')
      .select('state')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    last = row.state
    if (expected.includes(last)) return last
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`run resté en « ${last} », attendu ${expected.join(' ou ')}`)
}

async function verifierDemarrage(): Promise<void> {
  const stepId = await seedStep()

  const res = await app.inject({
    method: 'POST',
    url: `/api/steps/${stepId}/start`,
    cookies: { hm_session: cookie },
  })
  check('POST /api/steps/:id/start rend 201', res.statusCode === 201, String(res.statusCode))
  const { runId } = res.json()

  // Personne ne pousse : c'est le worker enregistré par `startBoss` qui
  // consomme le job, applique l'événement, et se ré-enfile tant que l'état
  // n'est pas terminal.
  const final = await waitForState(runId, ['awaiting_human', 'done', 'failed'])

  // Mode `gated` par défaut : un verdict conforme s'arrête sur la validation
  // humaine de fin de step, il ne conclut pas tout seul.
  check('la boucle atteint le gate humain', final === 'awaiting_human', final)

  // Filtré sur `approval` : la sonde de budget peut lever une `alert` en
  // parallèle, elle n'a rien à voir avec le gate de fin de step.
  const item = await db
    .selectFrom('inbox_items')
    .select(['type', 'subtype'])
    .where('run_id', '=', runId)
    .where('type', '=', 'approval')
    .executeTakeFirstOrThrow()
  check('un item approval est leve', item.type === 'approval', item.type)
  check('sous-type step_end', item.subtype === 'step_end', String(item.subtype))

  // Et le step n'est plus « en cours » : il attend une décision, pas un agent.
  const step = await db
    .selectFrom('steps')
    .select('status')
    .where('id', '=', stepId)
    .executeTakeFirstOrThrow()
  check(
    'le step reste occupe tant que la decision n est pas prise',
    step.status === 'running',
    step.status,
  )
}

async function verifierReprise(): Promise<void> {
  const stepId = await seedStep()
  const { runId } = (
    await app.inject({
      method: 'POST',
      url: `/api/steps/${stepId}/start`,
      cookies: { hm_session: cookie },
    })
  ).json()

  await waitForState(runId, ['awaiting_human'])

  // On remet le run en marche puis on le suspend : c'est la séquence que le
  // geste « pause · consigne · reprise » produit réellement.
  await db.updateTable('runs').set({ state: 'coding' }).where('id', '=', runId).execute()
  const pause = await app.inject({
    method: 'POST',
    url: `/api/runs/${runId}/pause`,
    cookies: { hm_session: cookie },
  })
  check('la pause repond 200', pause.statusCode === 200, String(pause.statusCode))
  const apresPause = (
    await db.selectFrom('runs').select('state').where('id', '=', runId).executeTakeFirstOrThrow()
  ).state
  check('l etat devient paused_human', apresPause === 'paused_human', apresPause)

  const resume = await app.inject({
    method: 'POST',
    url: `/api/runs/${runId}/resume`,
    cookies: { hm_session: cookie },
  })
  check('la reprise repond 200', resume.statusCode === 200, String(resume.statusCode))

  // Le piège que ce test existe pour attraper : le worker cesse de se
  // ré-enfiler en entrant dans `paused_human`. Sans le `boss.send` de la
  // route de reprise, le run repartirait en base et resterait immobile.
  const final = await waitForState(runId, ['awaiting_human', 'done', 'failed'])
  check('la boucle atteint le gate humain', final === 'awaiting_human', final)
}

// --- Exécution ------------------------------------------------------------

console.log('── Chaîne complète · HTTP → pg-boss → worker → machine à états ──')
await setup()
try {
  console.log('\n1. Démarrage d’une boucle depuis l’API')
  await verifierDemarrage()
  console.log('\n2. Reprise après une pause manuelle')
  await verifierReprise()
  console.log('\n✓ La chaîne est câblée de bout en bout.')
} finally {
  await teardown()
}

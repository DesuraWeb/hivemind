import type { Kysely } from 'kysely'
import { PgBoss } from 'pg-boss'
import { type BudgetSettingsSource, runBudgetTick } from '../budget/scheduler'
import type { Database } from '../db/types'
import { createSshGitTarget } from '../deploy/ssh-git'
import { type Env, databaseUrl } from '../env'
import { runAuthHealthcheck } from '../health/auth-check'
import type { GmailDraftPort } from '../integrations/gmail'
import type { Mailer } from '../integrations/mailer'
import { rappelerRevue } from '../knowledge/revue-notif'
import type { OpsExecutor } from '../ops/types'
import type { SondeHttp } from '../ops/types'
import type { RuntimeAdapter } from '../runtime/types'
import type { SettingsStore } from '../settings/store'
import { COMMUNICANT_QUEUE, registerCommunicantWorker } from './communicant'
import { OPS_APPLY_QUEUE, registerOpsApplyWorker } from './ops-apply'
import { PROD_DEPLOY_QUEUE, registerProdDeployWorker } from './prod-deploy'
import {
  RUN_STEP_QUEUE,
  type RunStepJobData,
  type StepRegistry,
  registerRunStepWorker,
} from './run-step'

/** Brief §4 : le healthcheck d'authentification tourne toutes les 15 minutes. */
export const AUTH_HEALTHCHECK_QUEUE = 'auth.healthcheck'
const AUTH_HEALTHCHECK_CRON = '*/15 * * * *'

/** La sonde de budget (Phase 5, Task 2). */
export const BUDGET_PROBE_QUEUE = 'budget.probe'

/** Le rappel de revue des savoirs (Phase 7 · le chaînon qui manquait). */
export const REVUE_RAPPEL_QUEUE = 'savoirs.rappel'
/**
 * Tous les lundis à 8 h.
 *
 * Le rythme de la REVUE est trimestriel (`PERIODE_REVUE_JOURS`), pas celui du
 * rappel : ce cron ne décide de rien, il pose la question. C'est
 * `deciderRappelRevue` qui refuse de parler quand la file n'a pas grandi et
 * que le dernier rappel a moins d'un mois — vérifier plus souvent ne peut donc
 * pas produire plus de bruit, seulement moins de retard.
 *
 * Lundi matin parce que le rappel atterrit dans l'inbox, et que l'inbox se lit
 * au brief du matin. Le samedi, il attendrait deux jours en tête de liste.
 */
const REVUE_RAPPEL_CRON = '0 8 * * 1'
/**
 * Toutes les 5 minutes. La mesure est gratuite (`runtime/usage.ts`), donc la
 * fréquence n'arbitre pas un coût en tokens — seulement un appel réseau d'une
 * seconde, et le retard de détection qu'on accepte.
 *
 * Le raisonnement tient dans la réserve : 15 points de la fenêtre de 5 h, soit
 * bien plus que ce qu'une boucle peut consommer en 5 minutes. Le retard de
 * détection est donc absorbé par construction. Descendre à la minute
 * multiplierait les appels par cinq sans rien protéger de plus ; monter à 15
 * minutes laisserait plusieurs runs parallèles grignoter la réserve avant
 * qu'on ne s'en aperçoive.
 */
const BUDGET_PROBE_CRON = '*/5 * * * *'

export interface BossDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  mailer: Mailer
  alertTo: string
  /**
   * Handlers de step à câbler sur le worker `run.step`. `index.ts` passe le
   * registre réel (`../loop/registry.ts`, Task 5, Phase 4) ; omis, `{}` reste
   * le défaut ci-dessous — c'est ce que gardent les tests qui n'exercent pas
   * la boucle elle-même, et ce que remplissent ceux qui le font.
   */
  stepRegistry?: StepRegistry
  /**
   * Boucles simultanées autorisées sur cette machine (`LOOP_CONCURRENCY`).
   * Omis, une seule — ce que gardent les tests, dont plusieurs comptent sur
   * un ordre d'exécution déterministe.
   */
  loopConcurrency?: number
  /**
   * Réglages lus par la sonde de budget (seuils, péremption). Typé au plus
   * étroit — `SettingsStore` le satisfait structurellement : pg-boss n'a
   * besoin que de lire des clés publiques, jamais des secrets.
   */
  settings: BudgetSettingsSource
  /**
   * Surface de rédaction du communicant. Omise, la queue existe quand même
   * mais sans worker : les jobs s'accumulent au lieu d'échouer, et un
   * redémarrage avec la dépendance les rattrape. C'est ce que gardent les
   * tests qui n'exercent pas la rédaction.
   */
  gmailDrafts?: GmailDraftPort
  /**
   * De quoi exécuter sur un serveur. Omis, la queue existe sans worker : les
   * changements approuvés attendent au lieu d'échouer, et un redémarrage avec
   * la dépendance les rattrape. C'est ce que gardent les tests — aucun d'eux
   * n'a de serveur à toucher.
   */
  opsExecutor?: OpsExecutor
  /**
   * Le coffre complet et la sonde HTTP, pour la mise en production.
   *
   * Les trois ensemble ou aucun : sans exécuteur on ne sauvegarde pas, sans
   * coffre on ne se connecte pas, sans sonde on ne vérifie pas que le site
   * répond après coup. En fournir deux sur trois donnerait une prod qui part
   * sans filet ou qu'on ne contrôle pas — pire que pas de prod du tout.
   */
  vault?: SettingsStore
  sondeHttp?: SondeHttp
}

/**
 * Construit l'instance pg-boss, sans la démarrer. pg-boss vit dans son propre
 * schéma Postgres (`pgboss` par défaut, distinct de `public`) : il n'entre
 * jamais en conflit avec les migrations applicatives ni avec le
 * `drop schema public cascade` que la suite de tests exécute avant chaque
 * fichier.
 */
export function createBoss(env: Env): PgBoss {
  return new PgBoss({ connectionString: databaseUrl(env) })
}

/**
 * Démarre pg-boss, déclare les queues, câble le worker `run.step` et le cron
 * du healthcheck d'authentification (brief §4), maintenant que l'infra de
 * file existe.
 */
export async function startBoss(boss: PgBoss, deps: BossDeps): Promise<void> {
  await boss.start()

  await boss.createQueue(RUN_STEP_QUEUE)
  await registerRunStepWorker(boss, deps.db, deps.stepRegistry ?? {}, deps.loopConcurrency ?? 1)

  await boss.createQueue(AUTH_HEALTHCHECK_QUEUE)
  await boss.work(AUTH_HEALTHCHECK_QUEUE, async () => {
    await runAuthHealthcheck({
      db: deps.db,
      adapter: deps.adapter,
      mailer: deps.mailer,
      alertTo: deps.alertTo,
    })
  })
  // Une seule planification pour ce nom de queue : `schedule` est idempotent
  // côté pg-boss (upsert sur la clé de queue), un redémarrage ne duplique pas
  // le cron.
  await boss.schedule(AUTH_HEALTHCHECK_QUEUE, AUTH_HEALTHCHECK_CRON)

  await boss.createQueue(BUDGET_PROBE_QUEUE)
  await boss.work(BUDGET_PROBE_QUEUE, async () => {
    await runBudgetTick({
      db: deps.db,
      adapter: deps.adapter,
      settings: deps.settings,
      // La reprise doit ré-enfiler le run elle-même : le worker `run.step`
      // s'est arrêté de se ré-enfiler en entrant dans `paused_budget`.
      enqueueRun: async (runId) => {
        await boss.send(RUN_STEP_QUEUE, { runId } satisfies RunStepJobData)
      },
    })
  })
  await boss.schedule(BUDGET_PROBE_QUEUE, BUDGET_PROBE_CRON)

  // La queue est créée dans tous les cas : `api/routes/inbox.ts` y envoie un
  // job à chaque mise en prod approuvée, et `boss.send` sur une queue
  // inexistante lève. Le worker, lui, n'existe que si de quoi rédiger a été
  // fourni.
  await boss.createQueue(REVUE_RAPPEL_QUEUE)
  await boss.work(REVUE_RAPPEL_QUEUE, async () => {
    await rappelerRevue(deps.db)
  })
  await boss.schedule(REVUE_RAPPEL_QUEUE, REVUE_RAPPEL_CRON)

  // Même arbitrage que la rédaction : la queue existe toujours (la route de
  // résolution y envoie), le worker seulement si de quoi exécuter a été fourni.
  await boss.createQueue(OPS_APPLY_QUEUE)
  if (deps.opsExecutor) {
    await registerOpsApplyWorker(boss, { db: deps.db, executor: deps.opsExecutor })
  }

  // La queue existe toujours (la route de résolution y envoie), le worker
  // seulement si de quoi déployer ET vérifier a été fourni.
  await boss.createQueue(PROD_DEPLOY_QUEUE)
  if (deps.opsExecutor && deps.vault && deps.sondeHttp) {
    const executor = deps.opsExecutor
    const vault = deps.vault
    await registerProdDeployWorker(boss, {
      db: deps.db,
      settings: vault,
      executor,
      http: deps.sondeHttp,
      // `bloquerLesRobots: false` · le `Disallow: /` du staging désindexerait
      // le site du client. C'est la seule différence entre les deux cibles au
      // niveau du poussage, et c'est la plus lourde de conséquences.
      poserLeCode: async (acces, ctx) => {
        const cible = createSshGitTarget({
          config: {
            host: acces.hote,
            user: acces.utilisateur,
            privateKey: acces.clePrivee,
            root: acces.chemin,
            domain: acces.domaine ?? acces.hote,
          },
          resolveSource: async () => ({
            repoFullName: (
              await deps.db
                .selectFrom('projects')
                .select('repo_full_name as repo')
                .where('slug', '=', ctx.projectSlug)
                .executeTakeFirstOrThrow()
            ).repo,
            // La branche de la CIBLE, pas celle du run : une prod déploie ce
            // qui a été fusionné, jamais la branche de travail d'un step.
            branch: acces.branche,
          }),
          resolveDir: () => acces.chemin,
          resolveUrl: () => (acces.domaine ? `https://${acces.domaine}` : `https://${acces.hote}`),
          bloquerLesRobots: false,
        })
        const r = await cible.deploy({
          runId: ctx.runId ?? '',
          worktreePath: '',
          projectSlug: ctx.projectSlug,
        })
        return r.ok
          ? { ok: true, detail: `code posé dans ${acces.chemin}` }
          : { ok: false, detail: r.reason }
      },
      horodater: () => new Date().toISOString().replace(/[:.]/g, '-'),
    })
  }

  await boss.createQueue(COMMUNICANT_QUEUE)
  if (deps.gmailDrafts) {
    await registerCommunicantWorker(boss, {
      db: deps.db,
      adapter: deps.adapter,
      drafts: deps.gmailDrafts,
    })
  }
}

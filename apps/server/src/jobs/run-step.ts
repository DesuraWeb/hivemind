import type { RunState } from '@silithid/shared'
import type { Kysely } from 'kysely'
import type { PgBoss } from 'pg-boss'
import type { Database } from '../db/types'
import type { LoopEvent } from '../domain/run-state'
import { applyEvent } from '../loop/orchestrator'

export const RUN_STEP_QUEUE = 'run.step'

export interface RunStepJobData {
  runId: string
}

/**
 * Exécute le travail réel d'un état actif (appeler l'agent, git, GitHub…) et
 * rend l'événement qui en résulte. Les six handlers (`framing.ts`,
 * `coding.ts`, `reviewing.ts`, `deploying.ts`, `judging.ts`, `verdict.ts`)
 * sont câblés en production par `../loop/registry.ts` (Task 5, Phase 4).
 * Volontairement hors DB : les effets de bord d'I/O externe ne doivent
 * jamais se trouver dans la même transaction que l'écriture d'état
 * (`applyEvent`).
 */
export type StepHandler = (db: Kysely<Database>, runId: string) => Promise<LoopEvent>

export type StepRegistry = Partial<Record<RunState, StepHandler>>

/**
 * États où le worker ne se ré-enfile jamais. Recopié tel quel depuis le plan
 * (Task 8, Step 4) : ce n'est pas une règle métier — la règle qui *produit*
 * ces états (épuisement de la boucle reviewer, budget, etc.) vit dans
 * `decide()`. Ceci n'est que le routage de la file : dans ces états, plus
 * personne n'attend le worker (un humain, ou le scheduler de budget).
 */
const NO_REQUEUE_STATES: ReadonlySet<RunState> = new Set([
  'awaiting_human',
  'paused_budget',
  // Comme `paused_budget` : le worker cesse de se ré-enfiler, donc la reprise
  // doit ré-enfiler le run elle-même (`POST /api/runs/:id/resume`). Sans ce
  // coup de pouce, le run repartirait en base sans que personne ne le fasse
  // avancer — le piège dans lequel le scheduler de budget est tombé.
  'paused_human',
  'done',
  'failed',
  'stopped',
])

export interface StepOnceResult {
  /** `false` si le run était déjà dans un état non actif : rien n'a été exécuté. */
  applied: boolean
  state: RunState
  /** `true` si l'appelant doit ré-enfiler un job `run.step` pour ce run. */
  requeue: boolean
}

/**
 * Fait avancer un run d'un seul pas.
 *
 * Idempotence : l'état est relu ici, puis à nouveau (et verrouillé) dans
 * `applyEvent`. Un job rejoué sur un run déjà avancé retrouve soit un état
 * non actif (retour immédiat, rien exécuté), soit un état actif pour lequel
 * l'événement que le handler produit n'est en général plus valide —
 * `applyEvent` lève alors sans avoir rien écrit. Dans les deux cas, aucune
 * double application.
 *
 * Ne boucle jamais indéfiniment sur un run bloqué : dès que l'état résultant
 * est dans `NO_REQUEUE_STATES`, `requeue` vaut `false` et l'appelant s'arrête.
 */
export async function stepOnce(
  db: Kysely<Database>,
  registry: StepRegistry,
  runId: string,
): Promise<StepOnceResult> {
  const run = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()

  if (NO_REQUEUE_STATES.has(run.state)) {
    return { applied: false, state: run.state, requeue: false }
  }

  const handler = registry[run.state]
  if (!handler) {
    throw new Error(`aucun exécuteur enregistré pour l'état "${run.state}" (run ${runId})`)
  }

  const event = await handler(db, runId)
  const { state } = await applyEvent(db, runId, event)

  return { applied: true, state, requeue: !NO_REQUEUE_STATES.has(state) }
}

/**
 * Câble `stepOnce` comme worker pg-boss de la queue `run.step`. Chaque
 * exécution ne fait avancer le run que d'un pas puis se ré-enfile elle-même
 * si le run est encore actif — c'est ce qui rend chaque pas retryable
 * indépendamment : une panne pendant le pas N ne perd que le pas N, jamais la
 * boucle entière (le job pg-boss du pas N est simplement rejoué).
 */
export async function registerRunStepWorker(
  boss: PgBoss,
  db: Kysely<Database>,
  registry: StepRegistry,
  /**
   * Combien de boucles avancent en même temps (`LOOP_CONCURRENCY`, env.ts).
   *
   * `localConcurrency` fait tourner N workers indépendants sur la même file :
   * chacun récupère son job, l'exécute, et échoue tout seul. C'est la
   * différence avec `batchSize`, qui remettrait N jobs au MÊME appel — une
   * seule exception ferait alors échouer les N runs du lot, dont ceux qui
   * n'avaient rien fait de mal.
   *
   * Le défaut reste 1 pour les appelants qui ne se prononcent pas (tests,
   * scripts) : leur faire hériter d'un parallélisme qu'ils n'ont pas demandé
   * changerait l'ordre d'exécution sous leurs pieds.
   */
  concurrency = 1,
): Promise<void> {
  await boss.work<RunStepJobData>(
    RUN_STEP_QUEUE,
    { localConcurrency: concurrency },
    async (jobs) => {
      for (const job of jobs) {
        const result = await stepOnce(db, registry, job.data.runId)
        if (result.requeue) {
          await boss.send(RUN_STEP_QUEUE, { runId: job.data.runId } satisfies RunStepJobData)
        }
      }
    },
  )
}

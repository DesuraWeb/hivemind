import type { Kysely } from 'kysely'
import type { Database } from '../db/types'

/**
 * Démarrer une boucle.
 *
 * ## Le trou que ça bouche
 *
 * Jusqu'ici, `insertInto('runs')` n'existait **que** dans les tests et les
 * scripts de diagnostic. Toute la machinerie était là — six handlers d'état,
 * la machine à états, les quatre gates, le juge visuel, le verdict, le
 * contrôle de run — et rien, dans le code de production, ne créait un run.
 * On pouvait mettre en pause, reprendre, arrêter et instruire une boucle
 * qu'aucune route ne savait lancer.
 *
 * ## Un seul run actif par step
 *
 * Deux runs simultanés sur le même step partageraient la même branche
 * (`run/<id>` est dérivé de l'id du run, donc distincte) mais viseraient le
 * même step et se disputeraient sa validation : deux verdicts contradictoires
 * sur le même travail, et un `steps.status` qui dépendrait de l'ordre
 * d'arrivée. On refuse, en disant lequel tourne déjà.
 *
 * Rien n'interdit en revanche deux runs sur deux steps **différents** du même
 * projet, ni sur deux projets : les worktrees sont isolés par run
 * (`git/worktree.ts`) et c'est justement ce qui rend le parallélisme possible.
 *
 * ## Ce que ça ne fait pas
 *
 * Aucune vérification que le dépôt existe, qu'on peut le cloner, que la
 * branche de base est bonne. Ces échecs-là appartiennent au premier handler
 * (`framing`), qui a déjà de quoi les exprimer proprement — et qui est
 * retentable par pg-boss. Les anticiper ici dupliquerait la logique et
 * ferait échouer le démarrage sur une panne réseau passagère.
 */

export interface StartRunResult {
  runId: string
  stepId: string
  position: number
  title: string
}

export class StepNotFoundError extends Error {
  constructor(stepId: string) {
    super(`step introuvable : ${stepId}`)
    this.name = 'StepNotFoundError'
  }
}

export class RunAlreadyActiveError extends Error {
  constructor(
    readonly runId: string,
    readonly state: string,
  ) {
    super(`un run est déjà en cours sur ce step (${runId}, état ${state})`)
    this.name = 'RunAlreadyActiveError'
  }
}

/** États dans lesquels un run occupe encore son step. Les trois terminaux le libèrent. */
const OCCUPYING_STATES = [
  'framing',
  'coding',
  'design_wait',
  'reviewing',
  'deploying',
  'judging',
  'verdict',
  'awaiting_human',
  'paused_budget',
  'paused_human',
] as const

export async function startRun(db: Kysely<Database>, stepId: string): Promise<StartRunResult> {
  const step = await db
    .selectFrom('steps')
    .select(['id', 'position', 'title'])
    .where('id', '=', stepId)
    .executeTakeFirst()
  if (!step) throw new StepNotFoundError(stepId)

  // Transaction : la vérification d'unicité et la création doivent être
  // atomiques, sinon deux clics rapprochés créent deux runs — le worker les
  // traiterait tous les deux.
  return db.transaction().execute(async (trx) => {
    const active = await trx
      .selectFrom('runs')
      .select(['id', 'state'])
      .where('step_id', '=', stepId)
      .where('state', 'in', OCCUPYING_STATES)
      .executeTakeFirst()
    if (active) throw new RunAlreadyActiveError(active.id, active.state)

    const run = await trx
      .insertInto('runs')
      .values({ step_id: stepId, state: 'framing' })
      .returning('id')
      .executeTakeFirstOrThrow()

    // `steps.status` suit l'existence d'un run actif : la liste des projets
    // dérive son statut du run (projects/derive.ts), mais la timeline des
    // steps lit cette colonne.
    await trx.updateTable('steps').set({ status: 'running' }).where('id', '=', stepId).execute()

    return { runId: run.id, stepId, position: step.position, title: step.title }
  })
}

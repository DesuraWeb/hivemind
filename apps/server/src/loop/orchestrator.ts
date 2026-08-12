import type { RunState } from '@silithid/shared'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../db/types'
import {
  type Decision,
  type Effect,
  type LoopEvent,
  type RunContext,
  decide,
} from '../domain/run-state'
import { eventBus } from '../events/bus'
import { appendMessage } from './bus'

/**
 * Borne dure des allers-retours dev↔reviewer (brief §7, décision A). Ce n'est
 * pas une règle métier — la règle elle-même (« au round N, basculer vers
 * awaiting_human ») vit entièrement dans `decide()`. C'est juste la valeur
 * que l'orchestrateur doit fournir en contexte : aucun réglage par projet
 * n'existe pour ce chiffre à ce stade du projet.
 */
const MAX_REVIEW_ROUNDS = 3

export interface ApplyEventResult {
  state: RunState
  decision: Decision
}

/**
 * Applique un événement à un run : lit son état et son contexte, demande la
 * décision au domaine, écrit l'état et les effets dans UNE transaction.
 *
 * Le domaine décide, l'orchestrateur applique. Aucune règle métier ici : si
 * une condition apparaît dans ce fichier, elle est au mauvais endroit.
 *
 * Atomicité : l'état, les effets et le `message` d'audit sont écrits dans une
 * seule transaction. Une décision `invalid` lève sans avoir rien écrit.
 *
 * Idempotence : la ligne `runs` est verrouillée (`select ... for update`) et
 * relue au début de la transaction — c'est la garde. Un job pg-boss rejoué
 * sur un run déjà avancé retrouve un état qui n'accepte plus l'événement
 * qu'il rejoue ; `decide()` renvoie `invalid`, rien n'est écrit.
 *
 * Diffusion SSE (plan Phase 3, Task 3) : publiée après le `return` de
 * `db.transaction().execute(...)`, donc après le commit — jamais pendant. Un
 * abonné ne doit jamais apprendre un état qu'un rollback pourrait encore
 * annuler.
 */
export async function applyEvent(
  db: Kysely<Database>,
  runId: string,
  event: LoopEvent,
): Promise<ApplyEventResult> {
  // Remplis pendant la transaction, lus après son commit — voir le
  // commentaire de fonction ci-dessus.
  const openedInboxItems: Array<{ id: string; projectId: string | null }> = []

  const { result, projectId } = await db.transaction().execute(async (trx) => {
    const run = await trx
      .selectFrom('runs')
      .innerJoin('steps', 'steps.id', 'runs.step_id')
      .innerJoin('projects', 'projects.id', 'steps.project_id')
      .select([
        'runs.state as state',
        'runs.iteration as iteration',
        'runs.review_round as reviewRound',
        'runs.resume_state as resumeState',
        'steps.project_id as projectId',
        'steps.max_iterations as maxIterations',
        'steps.autonomy as stepAutonomy',
        'projects.autonomy_default as projectAutonomy',
      ])
      // Verrou pris sur `runs` uniquement : c'est la seule table dont cette
      // fonction mute l'état. Sans lui, deux exécutions concurrentes du même
      // job pourraient toutes deux lire l'ancien état avant que l'une des
      // deux commite — `for update` sérialise les lectures concurrentes sur
      // la ligne du run.
      .forUpdate('runs')
      .where('runs.id', '=', runId)
      .executeTakeFirst()

    if (!run) throw new Error(`run introuvable : ${runId}`)

    const ctx: RunContext = {
      iteration: run.iteration,
      maxIterations: run.maxIterations,
      reviewRound: run.reviewRound,
      maxReviewRounds: MAX_REVIEW_ROUNDS,
      // `steps.autonomy` (nullable) prime sur `projects.autonomy_default` —
      // c'est la règle documentée par la migration 0001 (« null = hérite du
      // projet »), pas une décision prise ici.
      autonomy: run.stepAutonomy ?? run.projectAutonomy,
      // `exactOptionalPropertyTypes` interdit `resumeState: undefined` — la
      // clé doit être absente, pas présente avec cette valeur (cf. le même
      // commentaire dans run-state.test.ts).
      ...(run.resumeState ? { resumeState: run.resumeState } : {}),
    }

    const decision = decide(run.state, event, ctx)

    if (decision.kind === 'invalid') {
      throw new Error(
        `transition invalide (run ${runId}, état ${run.state}, événement ${event.type}) : ${decision.reason}`,
      )
    }

    const nextState = decision.kind === 'transition' ? decision.to : run.state

    if (decision.kind === 'transition') {
      await trx.updateTable('runs').set({ state: nextState }).where('id', '=', runId).execute()
    }

    for (const effect of decision.effects) {
      await applyEffect(trx, { runId, projectId: run.projectId }, effect, openedInboxItems)
    }

    // Brief §7 : toute transition (ou tout `stay`, qui reste une décision
    // appliquée par la machine) est tracée dans le bus, pas seulement les
    // passations entre rôles.
    await appendMessage(trx, {
      runId,
      fromRole: 'system',
      toRole: 'system',
      kind: 'info',
      body:
        decision.kind === 'transition'
          ? `${run.state} → ${nextState} (${event.type})`
          : `${run.state} (${event.type}, sans changement d'état)`,
      meta: { event, decision },
    })

    return { result: { state: nextState, decision }, projectId: run.projectId }
  })

  // Diffusion SSE après le commit (cf. commentaire de fonction). `run.state`
  // seulement sur une vraie transition — un `stay` ne change rien que le
  // front doive recharger.
  if (result.decision.kind === 'transition') {
    eventBus.publish({ type: 'run.state', runId, projectId })
  }
  for (const item of openedInboxItems) {
    eventBus.publish({ type: 'inbox.new', id: item.id, projectId: item.projectId })
  }

  return result
}

async function applyEffect(
  trx: Transaction<Database>,
  ctx: { runId: string; projectId: string },
  effect: Effect,
  openedInboxItems: Array<{ id: string; projectId: string | null }>,
): Promise<void> {
  switch (effect.type) {
    case 'open_inbox_item': {
      const row = await trx
        .insertInto('inbox_items')
        .values({
          type: effect.itemType,
          subtype: effect.subtype ?? null,
          project_id: ctx.projectId,
          run_id: ctx.runId,
          from_role: effect.fromRole,
          title: effect.reason,
          payload: JSON.stringify({ reason: effect.reason }),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      openedInboxItems.push({ id: row.id, projectId: ctx.projectId })
      return
    }

    case 'increment_iteration':
      await trx
        .updateTable('runs')
        .set((eb) => ({ iteration: eb('iteration', '+', 1) }))
        .where('id', '=', ctx.runId)
        .execute()
      return

    case 'increment_review_round':
      await trx
        .updateTable('runs')
        .set((eb) => ({ review_round: eb('review_round', '+', 1) }))
        .where('id', '=', ctx.runId)
        .execute()
      return

    case 'reset_review_round':
      await trx.updateTable('runs').set({ review_round: 0 }).where('id', '=', ctx.runId).execute()
      return

    case 'remember_resume_state':
      await trx
        .updateTable('runs')
        .set({ resume_state: effect.state })
        .where('id', '=', ctx.runId)
        .execute()
      return

    case 'clear_resume_state':
      await trx
        .updateTable('runs')
        .set({ resume_state: null })
        .where('id', '=', ctx.runId)
        .execute()
      return

    case 'end_run':
      await trx
        .updateTable('runs')
        .set({ ended_at: new Date() })
        .where('id', '=', ctx.runId)
        .execute()
      return
  }
}

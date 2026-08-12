import type { Kysely, Transaction } from 'kysely'
import { sql } from 'kysely'
import type { PgBoss } from 'pg-boss'
import type { Database } from '../db/types'
import { type RunContext, decide } from '../domain/run-state'
import { eventBus } from '../events/bus'
import { RUN_STEP_QUEUE, type RunStepJobData } from '../jobs/run-step'
import { appendMessage } from '../loop/bus'
import { type InboxItemRow, toInboxItemRow } from './repo'

/**
 * Réponse humaine à un item d'inbox. `text` est la seule clé que ce module
 * interprète (c'est le `a` archivé vers la fiche client pour une question,
 * brief §7) ; le reste passe tel quel dans `human_response`, forme libre
 * selon le panneau (approve/reject, brouillon corrigé…) — ce n'est pas à ce
 * module de la contraindre, seulement de la conserver.
 */
export type InboxResponse = Record<string, unknown> & { text?: string }

export interface ResolveInboxItemResult {
  item: InboxItemRow
  /** `true` si l'item bloquait un run et que ce run est reparti. */
  runResumed: boolean
}

/**
 * Résout un item d'inbox.
 *
 * Deux effets doivent être atomiques : marquer l'item `done` et faire
 * repartir le run qu'il bloquait. Un item `done` sans run reparti laisse une
 * boucle morte invisible ; un run reparti sans item résolu produira un
 * doublon au prochain passage (aucun retry ne rattrape ces deux états, cf. le
 * plan Phase 3). Donc : une seule transaction Postgres pour l'item ET la
 * reprise du run — voir `resumeRunIfBlocked` pour pourquoi ce n'est PAS
 * `applyEvent` (orchestrator.ts) qui fait la reprise ici.
 *
 * Le ré-enfilage pg-boss du job `run.step`, lui, arrive APRÈS le commit —
 * exactement comme `registerRunStepWorker` (jobs/run-step.ts) ré-enfile après
 * que `stepOnce` a committé son propre `applyEvent`. C'est « le même chemin
 * que n'importe quelle autre transition, pas une voie parallèle » (plan
 * Phase 3) : si le process meurt entre le commit et l'envoi du job, le run
 * est repris en base mais personne ne le sait tant qu'un autre déclencheur ne
 * le relance — un défaut de liveness, jamais un doublon ni une incohérence
 * item/run, puisque `stepOnce` relit l'état courant à chaque exécution.
 */
export async function resolveInboxItem(
  db: Kysely<Database>,
  boss: PgBoss,
  id: string,
  response: InboxResponse,
): Promise<ResolveInboxItemResult> {
  const { item, runIdToResume } = await db.transaction().execute(async (trx) => {
    // Verrou sur la ligne de l'item : deux résolutions concurrentes du même
    // id se sérialisent ici. La seconde, une fois le verrou obtenu, relit un
    // statut qui n'est plus `open` et refuse — exactement comme `applyEvent`
    // sérialise les transitions concurrentes d'un même run (orchestrator.ts).
    const current = await trx
      .selectFrom('inbox_items')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()

    if (!current) throw new Error(`item d'inbox introuvable : ${id}`)
    if (current.status !== 'open') {
      throw new Error(`item d'inbox ${id} déjà résolu (statut ${current.status})`)
    }

    // Un item porte `run_id` s'il est né dans une boucle (question, alerte de
    // review épuisée, approbation de step_end…) — mais toutes les questions
    // liées à un run ne le bloquent pas (brief §7 : seule une question
    // bloquante met le run en attente). `resumeRunIfBlocked` revérifie l'état
    // courant sous verrou : c'est le seul signal fiable de « cet item bloque
    // encore » — l'avoir bloqué au moment de sa création ne suffit pas (le
    // run a pu déjà repartir par une autre voie, ou avoir échoué depuis).
    let runIdToResume: string | null = null
    if (current.run_id && (await resumeRunIfBlocked(trx, current.run_id))) {
      runIdToResume = current.run_id
    }

    const resolved = await trx
      .updateTable('inbox_items')
      .set({
        status: 'done',
        human_response: JSON.stringify(response),
        resolved_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow()

    if (current.archive_to_client && current.type === 'question' && current.project_id) {
      await archiveQuestionToClient(trx, current.project_id, {
        q: current.title,
        a: response.text,
        sourceItemId: id,
      })
    }

    return {
      item: toInboxItemRow(resolved),
      runIdToResume,
    }
  })

  // Diffusion SSE après le commit de la transaction ci-dessus (jamais
  // pendant) : un abonné ne doit jamais apprendre une résolution qu'un
  // rollback pourrait encore annuler. `run.state`, lui, n'est PAS republié
  // ici : la reprise du run passe par `resumeRunIfBlocked`, qui duplique
  // volontairement la plomberie d'`applyEvent` sans son point de diffusion
  // (cf. le commentaire de cette fonction et le point ouvert 4 du plan Phase
  // 3 — un écart connu, pas un oubli). Le prochain passage du job dans
  // `applyEvent` republiera `run.state` à la transition suivante.
  eventBus.publish({ type: 'inbox.resolved', id: item.id, projectId: item.projectId })

  if (runIdToResume) {
    await boss.send(RUN_STEP_QUEUE, { runId: runIdToResume } satisfies RunStepJobData)
  }

  return { item, runResumed: runIdToResume !== null }
}

/**
 * Reprend un run bloqué en émettant `human_resolved`, dans la MÊME
 * transaction que la résolution de l'item qui le bloquait — pas via
 * `applyEvent` (orchestrator.ts).
 *
 * Kysely ne supporte pas les transactions imbriquées : `Transaction`
 * (l'objet `trx` reçu ici) surcharge sa propre méthode `transaction()` pour
 * lever explicitement (« calling the transaction method for a Transaction is
 * not supported », kysely.js) plutôt que de créer un savepoint. Appeler
 * `applyEvent(trx, runId, event)` depuis une transaction déjà ouverte
 * lèverait donc systématiquement. Rouvrir une transaction séparée avec
 * `applyEvent(db, ...)` (nouvelle connexion) romprait exactement
 * l'atomicité que cette fonction existe pour garantir. D'où cette
 * duplication ciblée de la plomberie transactionnelle d'`applyEvent` (verrou
 * `FOR UPDATE`, écriture d'état, effets, message d'audit) — et pourquoi
 * `orchestrator.ts` n'est pas modifié : ce n'est pas lui qui doit changer,
 * c'est une limite de Kysely qui empêche de le réutiliser tel quel ici.
 *
 * La règle métier elle-même n'est PAS redérivée : `decide()` (run-state.ts)
 * est appelé tel quel, seule la plomberie autour est dupliquée.
 *
 * Retourne `false` sans rien écrire si le run n'est plus `awaiting_human`
 * (résolu par une autre voie entre-temps, ou terminé) : l'item est alors
 * simplement marqué résolu, sans toucher au run.
 */
async function resumeRunIfBlocked(trx: Transaction<Database>, runId: string): Promise<boolean> {
  const run = await trx
    .selectFrom('runs')
    .innerJoin('steps', 'steps.id', 'runs.step_id')
    .innerJoin('projects', 'projects.id', 'steps.project_id')
    .select([
      'runs.state as state',
      'runs.iteration as iteration',
      'runs.review_round as reviewRound',
      'runs.resume_state as resumeState',
      'steps.max_iterations as maxIterations',
      'steps.autonomy as stepAutonomy',
      'projects.autonomy_default as projectAutonomy',
    ])
    .forUpdate('runs')
    .where('runs.id', '=', runId)
    .executeTakeFirst()

  if (!run) throw new Error(`run introuvable : ${runId}`)
  if (run.state !== 'awaiting_human') return false

  const ctx: RunContext = {
    iteration: run.iteration,
    maxIterations: run.maxIterations,
    reviewRound: run.reviewRound,
    // Dupliqué de `MAX_REVIEW_ROUNDS` (orchestrator.ts, non exporté, valeur 3
    // documentée brief §7). Sans effet ici : `decide()` retourne avant de lire
    // ce champ dans la branche `awaiting_human` (run-state.ts) — mais un
    // `RunContext` complet et réel est plus sûr qu'un placeholder si cette
    // branche évolue.
    maxReviewRounds: 3,
    autonomy: run.stepAutonomy ?? run.projectAutonomy,
    ...(run.resumeState ? { resumeState: run.resumeState } : {}),
  }

  const decision = decide('awaiting_human', { type: 'human_resolved' }, ctx)

  if (decision.kind === 'invalid') {
    throw new Error(`reprise du run ${runId} impossible : ${decision.reason}`)
  }
  if (decision.kind === 'stay') {
    throw new Error(
      `decide() a renvoyé 'stay' pour human_resolved (run ${runId}) : cas non prévu par cette résolution ciblée`,
    )
  }

  await trx.updateTable('runs').set({ state: decision.to }).where('id', '=', runId).execute()

  for (const effect of decision.effects) {
    if (effect.type !== 'clear_resume_state') {
      throw new Error(
        `effet ${effect.type} inattendu pour human_resolved (run ${runId}) : non géré par cette résolution ciblée`,
      )
    }
    await trx.updateTable('runs').set({ resume_state: null }).where('id', '=', runId).execute()
  }

  // Brief §7 : toute transition est tracée dans le bus (même règle
  // qu'`applyEvent`, dupliquée ici pour la même raison que le reste).
  await appendMessage(trx, {
    runId,
    fromRole: 'system',
    toRole: 'system',
    kind: 'info',
    body: `awaiting_human → ${decision.to} (human_resolved)`,
    meta: { event: { type: 'human_resolved' }, decision },
  })

  return true
}

interface ClientNote {
  q: string
  a: string | undefined
  sourceItemId: string
}

/**
 * Ajoute une entrée `{q, a, source_item_id, at}` (brief §7, cf. le commentaire
 * de `clients.notes` dans 0001_init.sql) à la fiche du client rattaché au
 * projet de l'item. Silencieux si le projet n'a pas de client (`client_id`
 * nul) ou si `response.text` est absent : mieux vaut une note manquante
 * qu'une entrée `{a: undefined}` dans l'historique client.
 */
async function archiveQuestionToClient(
  trx: Transaction<Database>,
  projectId: string,
  note: ClientNote,
): Promise<void> {
  if (note.a === undefined) return

  const project = await trx
    .selectFrom('projects')
    .select('client_id')
    .where('id', '=', projectId)
    .executeTakeFirst()
  if (!project?.client_id) return

  const entry = {
    q: note.q,
    a: note.a,
    source_item_id: note.sourceItemId,
    at: new Date().toISOString(),
  }

  await trx
    .updateTable('clients')
    .set({ notes: sql`notes || ${JSON.stringify([entry])}::jsonb` })
    .where('id', '=', project.client_id)
    .execute()
}

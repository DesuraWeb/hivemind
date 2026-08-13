import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { z } from 'zod'
import {
  DEFAULT_UNLOCK_MINUTES,
  MAX_UNLOCK_MINUTES,
  RESERVE_UNLOCK_SETTINGS_KEY,
  clampUnlockMinutes,
  effectivePauseThreshold,
  parseUnlockUntil,
} from '../../budget/reserve'
import { decideBudget, loadBudgetThresholds } from '../../budget/scheduler'
import type { Database } from '../../db/types'
import { RUN_STEP_QUEUE, type RunStepJobData } from '../../jobs/run-step'
import { applyEvent } from '../../loop/orchestrator'
import type { RuntimeAdapter } from '../../runtime/types'
import type { SettingsStore } from '../../settings/store'

/**
 * La jauge de budget, et le seul geste qui permet d'entamer la réserve.
 *
 * Sans cette route, le scheduler protège 15 points que personne ne peut
 * dépenser : à 85 % tout est en pause, et Florian n'a aucun moyen de finir un
 * correctif urgent. Une réserve inaccessible n'est pas une réserve.
 *
 * Le déblocage est daté et borné (voir `budget/reserve.ts`) : il expire tout
 * seul, parce qu'oublier de refermer est le comportement normal d'un humain
 * occupé, pas une faute à sanctionner par une facture.
 */

export interface BudgetRoutesDeps {
  db: Kysely<Database>
  settings: SettingsStore
  adapter: Pick<RuntimeAdapter, 'usage'>
  boss: PgBoss
}

const unlockBody = z.object({
  /** Durée du déblocage. Bornée à deux heures côté serveur, quoi qu'envoie le client. */
  minutes: z.number().optional(),
})

export async function budgetRoutes(app: FastifyInstance, deps: BudgetRoutesDeps): Promise<void> {
  /**
   * L'état de la jauge, tel que le pack DA l'affiche (`BUDGET` de data.js) :
   * les deux fenêtres, l'état de la réserve, l'heure de remise à zéro.
   *
   * La mesure est gratuite (`runtime/usage.ts`), donc cette route ne coûte
   * rien à appeler — mais elle n'invente rien non plus : jauge indisponible ⇒
   * `gauge: null`, et c'est au front d'afficher « inconnu » plutôt qu'un zéro
   * qui laisserait croire que tout va bien.
   */
  app.get('/api/budget', { preHandler: app.requireAuth }, async () => {
    const now = new Date()
    const thresholds = await loadBudgetThresholds(deps.settings)
    const reserve = parseUnlockUntil(await deps.settings.get(RESERVE_UNLOCK_SETTINGS_KEY), now)

    let snapshot = null
    try {
      snapshot = await deps.adapter.usage()
    } catch {
      // Un runtime injoignable n'est pas une jauge à 0 % : `null` est la seule
      // lecture honnête, et la route répond quand même.
      snapshot = null
    }
    const decision = decideBudget(snapshot, thresholds, now, reserve)

    return {
      gauge: decision.gauge,
      reason: decision.reason,
      resetsAt: snapshot?.resetsAt ?? null,
      reserve: {
        state: reserve.state,
        pct: thresholds.reservePct,
        until: reserve.until ?? null,
      },
      thresholds: {
        pause: effectivePauseThreshold(thresholds, reserve),
        // Le seuil permanent, affiché à côté de l'effectif : « 85 %,
        // dérogation en cours » se lit, « 100 % » tout seul ne se lit pas.
        pauseNominal: 100 - thresholds.reservePct,
        resume: thresholds.resumePct,
      },
    }
  })

  /**
   * Entame la réserve : les runs en pause budgétaire repartent, et le seuil ne
   * s'applique plus jusqu'à l'échéance.
   *
   * Reprendre les runs sans lever le seuil ne servirait à rien : le tick
   * suivant, cinq minutes plus tard, les remettrait en pause. Les deux gestes
   * sont donc indissociables.
   */
  app.post('/api/budget/reserve/unlock', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = unlockBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'corps_invalide' })

    const minutes = clampUnlockMinutes(parsed.data.minutes)
    const until = new Date(Date.now() + minutes * 60_000)
    await deps.settings.set(RESERVE_UNLOCK_SETTINGS_KEY, until.toISOString())

    const paused = await deps.db
      .selectFrom('runs')
      .select('id')
      .where('state', '=', 'paused_budget')
      .where('ended_at', 'is', null)
      .execute()

    const resumed: string[] = []
    const skipped: { runId: string; error: string }[] = []
    for (const run of paused) {
      try {
        await applyEvent(deps.db, run.id, { type: 'budget_resume' })
        resumed.push(run.id)
      } catch (err) {
        // Un run qui a changé d'état entre la lecture et l'écriture ne doit ni
        // faire échouer la requête, ni disparaître en silence.
        skipped.push({ runId: run.id, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // Après le commit d'`applyEvent`, jamais avant : un job envoyé sur un run
    // dont la transition serait annulée trouverait un état encore en pause.
    // Même ordre que le scheduler, pour la même raison.
    for (const runId of resumed) {
      await deps.boss.send(RUN_STEP_QUEUE, { runId } satisfies RunStepJobData)
    }

    return { until, minutes, resumed, skipped, maxMinutes: MAX_UNLOCK_MINUTES }
  })

  /**
   * Referme la réserve avant l'échéance. Ne remet rien en pause de lui-même :
   * c'est le prochain tick du scheduler qui appliquera de nouveau le seuil, et
   * il vaut mieux qu'une seule décision de pause existe dans tout le système.
   */
  app.post('/api/budget/reserve/lock', { preHandler: app.requireAuth }, async () => {
    await deps.settings.set(RESERVE_UNLOCK_SETTINGS_KEY, null)
    return { state: 'intacte', defaultMinutes: DEFAULT_UNLOCK_MINUTES }
  })
}

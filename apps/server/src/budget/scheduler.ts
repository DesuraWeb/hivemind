import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/types'
import { eventBus } from '../events/bus'
import { createInboxItem } from '../inbox/repo'
import { applyEvent } from '../loop/orchestrator'
import { loopFromRunState } from '../projects/derive'
import type { RuntimeAdapter, UsageSnapshot } from '../runtime/types'
import {
  RESERVE_UNLOCK_SETTINGS_KEY,
  type ReserveStatus,
  effectivePauseThreshold,
  parseUnlockUntil,
} from './reserve'

/**
 * Le scheduler de budget (Phase 5, Task 2) : met les boucles en pause quand la
 * consommation du compte entame la réserve, les fait repartir quand elle
 * redescend.
 *
 * ## Ce qui rend ce fichier possible
 *
 * `runtime/usage.ts` (Task 1) rend enfin de vrais pourcentages, gratuitement.
 * Avant lui `usage()` répondait `available: false` en permanence : un
 * scheduler construit là-dessus n'aurait jamais rien mis en pause, et personne
 * ne s'en serait aperçu.
 *
 * ## La règle dure, qu'on ne contourne pas
 *
 * `available: false` ⇒ AUCUNE pause, jamais (contrat écrit dans
 * `runtime/types.ts`). On ne va pas non plus rechercher une vieille valeur en
 * base pour se donner le droit de décider quand même : mieux vaut dépasser une
 * limite que suspendre le travail sur une jauge inventée. La contrepartie est
 * qu'un silence prolongé de la jauge doit se VOIR — d'où l'item d'inbox
 * ci-dessous, sur le modèle non bloquant de `health/auth-check.ts`.
 *
 * ## La règle de péremption du garant
 *
 * Mesure fraîche ≤ 90 min. Au-delà : la jauge s'affiche « inconnu »
 * (`known: false`) et le scheduler décide sur la dernière valeur MAJORÉE de
 * 10 points. C'est une dégradation, pas le régime nominal : `probeUsage()`
 * date chaque mesure à l'instant où elle est prise, donc en marche normale la
 * mesure a quelques secondes. Le cas périmé n'arrive que par la source
 * secondaire (`captureRateLimit`, cf. `runtime/claude.ts`) ou si l'API
 * expérimentale disparaît en cours de route.
 *
 * S'il n'y a JAMAIS eu de mesure, la majoration n'a rien à majorer : 0 + 10
 * serait un chiffre fabriqué, pas une estimation prudente. Ce cas rejoint donc
 * `available: false` — jauge nulle, aucune décision. C'est aussi ce qui se
 * passe au tout premier tick d'un process neuf si la sonde échoue.
 */

/**
 * Ce que le scheduler lit dans les réglages. `SettingsStore` le satisfait
 * structurellement. Volontairement non générique et rendant `unknown` : une
 * valeur de `settings` vient d'un `PUT /api/settings` qui accepte n'importe
 * quel JSON, la typer à la lecture serait une promesse que personne ne tient
 * — c'est `sanitizeThresholds` qui la valide.
 */
export interface BudgetSettingsSource {
  get(key: string): Promise<unknown>
}

/** Clés de `settings` pilotant le scheduler. Modifiables sans redéploiement. */
export const BUDGET_SETTINGS_KEYS = {
  reservePct: 'budget.reserve_pct',
  resumePct: 'budget.resume_pct',
  stalenessMinutes: 'budget.staleness_minutes',
  staleBumpPct: 'budget.stale_bump_pct',
} as const

export interface BudgetThresholds {
  /**
   * La réserve du pack DA (`BUDGET.reserve`, valeur 15) : les derniers points
   * de jauge, gardés pour les urgences. Le seuil de pause n'est pas un réglage
   * séparé, il en DÉCOULE (100 − réserve = 85 %) — sinon les deux pourraient
   * se contredire et « réserve intacte » deviendrait un mot sans effet.
   */
  reservePct: number
  /**
   * Retour sous ce seuil ⇒ reprise. Strictement inférieur au seuil de pause :
   * l'écart est l'hystérésis, sans quoi une jauge qui oscille d'un point
   * autour de 85 % produirait une pause et une reprise à chaque tick.
   */
  resumePct: number
  /** Âge au-delà duquel une mesure ne fait plus foi (règle du garant : 90 min). */
  stalenessMinutes: number
  /** Majoration appliquée à une mesure périmée (règle du garant : 10 points). */
  staleBumpPct: number
}

/**
 * Défauts.
 *
 * - `reservePct: 15` — la valeur du pack DA, donc pause à 85 %. Une boucle
 *   ordinaire ne descend jamais dans ces 15 points : ils restent disponibles
 *   pour un correctif urgent lancé à la main.
 * - `resumePct: 75` — 10 points d'hystérésis. La fenêtre de 5 h ne redescend
 *   pas d'un point par hasard : soit elle se vide vraiment (remise à zéro),
 *   soit elle stagne. Une bande de 10 points garantit qu'une reprise
 *   correspond à une vraie décrue, pas à du bruit de mesure.
 * - `stalenessMinutes: 90` / `staleBumpPct: 10` — la règle du garant, reprise
 *   telle quelle.
 */
export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = {
  reservePct: 15,
  resumePct: 75,
  stalenessMinutes: 90,
  staleBumpPct: 10,
}

/** Seuil de pause : tout ce qui est au-dessus entame la réserve. */
export function pauseThreshold(t: BudgetThresholds): number {
  return 100 - t.reservePct
}

function readNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value < min || value > max) return fallback
  return value
}

/**
 * Valide des valeurs venues des réglages avant de leur faire confiance : un
 * `PUT /api/settings` accepte n'importe quel JSON (cf. `api/routes/settings.ts`),
 * et un seuil aberrant transformerait le scheduler en générateur de pauses.
 * Pure et exportée : c'est là que vivent les garde-fous, pas dans la lecture.
 */
export function sanitizeThresholds(
  raw: Partial<Record<keyof BudgetThresholds, unknown>>,
): BudgetThresholds {
  const reservePct = readNumber(raw.reservePct, 0, 100, DEFAULT_BUDGET_THRESHOLDS.reservePct)
  const stalenessMinutes = readNumber(
    raw.stalenessMinutes,
    1,
    24 * 60,
    DEFAULT_BUDGET_THRESHOLDS.stalenessMinutes,
  )
  const staleBumpPct = readNumber(raw.staleBumpPct, 0, 100, DEFAULT_BUDGET_THRESHOLDS.staleBumpPct)
  const pause = 100 - reservePct
  let resumePct = readNumber(raw.resumePct, 0, 100, DEFAULT_BUDGET_THRESHOLDS.resumePct)
  // Un seuil de reprise au-dessus (ou égal à) celui de pause supprimerait
  // l'hystérésis : la même mesure déclencherait pause ET reprise. On retombe
  // sur la bande par défaut plutôt que d'appliquer une configuration qui
  // ferait battre la boucle.
  if (resumePct >= pause) {
    resumePct = Math.max(0, pause - (DEFAULT_BUDGET_THRESHOLDS.reservePct - 5))
  }
  return { reservePct, resumePct, stalenessMinutes, staleBumpPct }
}

export async function loadBudgetThresholds(
  settings: BudgetSettingsSource,
): Promise<BudgetThresholds> {
  const [reservePct, resumePct, stalenessMinutes, staleBumpPct] = await Promise.all([
    settings.get(BUDGET_SETTINGS_KEYS.reservePct),
    settings.get(BUDGET_SETTINGS_KEYS.resumePct),
    settings.get(BUDGET_SETTINGS_KEYS.stalenessMinutes),
    settings.get(BUDGET_SETTINGS_KEYS.staleBumpPct),
  ])
  return sanitizeThresholds({ reservePct, resumePct, stalenessMinutes, staleBumpPct })
}

export type BudgetAction = 'pause' | 'resume' | 'none'

export interface BudgetGauge {
  /** Pourcentage retenu pour décider : le max des deux fenêtres, majoration comprise. */
  pct: number
  /** `false` quand la mesure est périmée : la jauge s'affiche « inconnu », même si on décide quand même. */
  known: boolean
  fiveHourPct: number
  sevenDayPct: number
  /** Âge de la mesure en minutes ; `null` si elle n'était pas datée. */
  ageMinutes: number | null
}

export interface BudgetDecision {
  action: BudgetAction
  /** `null` quand il n'existe aucune mesure du tout : rien à majorer, rien à décider. */
  gauge: BudgetGauge | null
  reason: string
}

/**
 * La décision, sans base ni réseau. Tout le reste de ce fichier n'est que de
 * la plomberie autour d'elle.
 *
 * Les deux fenêtres sont ramenées à une seule valeur par leur MAXIMUM, et la
 * réserve s'applique aux deux : le même arbitrage que `foldRateLimits`
 * (`runtime/usage.ts`) — sous-estimer ferait tourner la boucle au-delà de la
 * limite réelle, surestimer ne coûte qu'une pause prématurée.
 */
export function decideBudget(
  snapshot: UsageSnapshot | null,
  thresholds: BudgetThresholds,
  now: Date,
  /**
   * État de la réserve. Par défaut intacte : le seuil s'applique. Entamée, il
   * ne s'applique plus — c'est le sens même de puiser dans la réserve, et sans
   * ça une reprise manuelle serait annulée cinq minutes plus tard par le tick
   * suivant (voir `./reserve.ts`).
   */
  reserve: ReserveStatus = { state: 'intacte' },
): BudgetDecision {
  if (!snapshot || !snapshot.available) {
    return {
      action: 'none',
      gauge: null,
      reason: "jauge indisponible · le runtime n'expose pas la consommation",
    }
  }

  const raw = Math.max(snapshot.fiveHourPct, snapshot.sevenDayPct)
  // Une mesure non datée est une mesure dont on ne peut pas prouver la
  // fraîcheur : traitée comme périmée, jamais comme fraîche par défaut.
  const ageMinutes = snapshot.sampledAt
    ? (now.getTime() - snapshot.sampledAt.getTime()) / 60_000
    : null
  const fresh = ageMinutes !== null && ageMinutes <= thresholds.stalenessMinutes

  const pct = fresh ? raw : Math.min(100, raw + thresholds.staleBumpPct)
  const gauge: BudgetGauge = {
    pct,
    known: fresh,
    fiveHourPct: snapshot.fiveHourPct,
    sevenDayPct: snapshot.sevenDayPct,
    ageMinutes,
  }

  const pause = effectivePauseThreshold(thresholds, reserve)
  const label = fresh
    ? `${pct} %`
    : `${pct} % (mesure périmée · majorée de ${thresholds.staleBumpPct} points)`

  if (pct >= pause) {
    return {
      action: 'pause',
      gauge,
      reason: `${label} · réserve de ${thresholds.reservePct} points entamée`,
    }
  }
  if (pct <= thresholds.resumePct) {
    return {
      action: 'resume',
      gauge,
      reason: `${label} · sous le seuil de reprise (${thresholds.resumePct} %)`,
    }
  }
  return {
    action: 'none',
    gauge,
    reason: `${label} · dans la bande d'hystérésis (${thresholds.resumePct} % → ${pause} %)`,
  }
}

/** Cause portée par l'item d'inbox, comme `auth.runtime_indisponible` pour le healthcheck. */
export const BUDGET_UNKNOWN_ALERT_KEY = 'budget.jauge_indisponible'

/**
 * Fenêtre de dédoublonnage de cette alerte. Volontairement basée sur la date
 * de création et non sur le statut « ouvert » (contrairement à
 * `auth-check.ts`) : sur un compte sans limites de plan (clé API, Bedrock,
 * Vertex) la jauge est indisponible POUR TOUJOURS, et un dédoublonnage sur le
 * statut recréerait un item à chaque fois que Florian en résout un.
 */
const ALERT_DEDUP_HOURS = 24

export interface BudgetTickDeps {
  db: Kysely<Database>
  /** Seule `usage()` est utilisée : plus étroit que `RuntimeAdapter`, donc simple à simuler en test. */
  adapter: Pick<RuntimeAdapter, 'usage'>
  settings: BudgetSettingsSource
  /**
   * Ré-enfile un job `run.step`. Indispensable à la reprise : le worker cesse
   * de se ré-enfiler dès qu'un run entre en `paused_budget`
   * (`NO_REQUEUE_STATES`, jobs/run-step.ts), donc sans ce coup de pouce le run
   * repartirait en base sans que personne ne le fasse avancer.
   */
  enqueueRun: (runId: string) => Promise<void>
  now?: () => Date
}

export interface BudgetTickResult {
  decision: BudgetDecision
  pausedRunIds: string[]
  resumedRunIds: string[]
  /** Runs qu'on a voulu bouger sans y arriver (état changé entre-temps) : jamais avalé en silence. */
  skipped: { runId: string; error: string }[]
  /** `true` si un item d'inbox a été levé pour signaler une jauge muette. */
  alerted: boolean
}

/**
 * Un tick de la sonde : mesure, décide, applique.
 *
 * Une sonde muette ne fait pas tomber le tick (même raison que `probeUsageOn` :
 * le remède serait pire que le mal), et un run qui a changé d'état entre la
 * lecture et l'application ressort dans `skipped` — jamais avalé en silence,
 * jamais fatal aux autres runs. Seule une panne de base remonte à pg-boss, qui
 * rejouera le job : c'est le comportement voulu, il n'y a rien à rattraper
 * localement quand Postgres ne répond plus.
 */
export async function runBudgetTick(deps: BudgetTickDeps): Promise<BudgetTickResult> {
  const now = deps.now?.() ?? new Date()
  const thresholds = await loadBudgetThresholds(deps.settings)

  let snapshot: UsageSnapshot | null = null
  try {
    snapshot = await deps.adapter.usage()
  } catch {
    // Un runtime injoignable n'est pas une jauge à 0 % : rester sur `null`,
    // c'est-à-dire « inconnu », est la seule lecture honnête.
    snapshot = null
  }

  // La réserve est lue à chaque tick, jamais mise en cache : une dérogation
  // expire toute seule, et c'est le tick suivant qui doit s'en apercevoir.
  const reserve = parseUnlockUntil(await deps.settings.get(RESERVE_UNLOCK_SETTINGS_KEY), now)
  const decision = decideBudget(snapshot, thresholds, now, reserve)
  const result: BudgetTickResult = {
    decision,
    pausedRunIds: [],
    resumedRunIds: [],
    skipped: [],
    alerted: false,
  }

  const runs = await deps.db
    .selectFrom('runs')
    .innerJoin('steps', 'steps.id', 'runs.step_id')
    .select(['runs.id as id', 'runs.state as state', 'steps.project_id as projectId'])
    .where('runs.ended_at', 'is', null)
    .execute()

  if (!decision.gauge) {
    // On n'alerte que si le silence coûte quelque chose : sans run en cours,
    // il n'y a rien à protéger et l'item ne serait que du bruit.
    const atRisk = runs.some((r) => loopFromRunState(r.state) === 'run')
    if (atRisk) result.alerted = await raiseUnknownGaugeAlert(deps.db, now)
    return result
  }

  const touchedProjects = new Set<string>()

  if (decision.action === 'pause') {
    // `loopFromRunState(...) === 'run'` est exactement la partition
    // `ACTIVE_STATES` de la machine à états (cf. projects/derive.ts) :
    // réutilisée plutôt que recopiée. Un run déjà en `paused_budget`, en
    // `awaiting_human`, `done` ou `failed` n'en fait pas partie — il ne reçoit
    // donc pas de second `budget_pause` au tick suivant, et une attente
    // humaine n'est jamais écrasée par une pause budgétaire.
    for (const run of runs.filter((r) => loopFromRunState(r.state) === 'run')) {
      try {
        await applyEvent(deps.db, run.id, { type: 'budget_pause' })
        result.pausedRunIds.push(run.id)
        touchedProjects.add(run.projectId)
      } catch (err) {
        result.skipped.push({
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  if (decision.action === 'resume') {
    for (const run of runs.filter((r) => r.state === 'paused_budget')) {
      try {
        await applyEvent(deps.db, run.id, { type: 'budget_resume' })
        result.resumedRunIds.push(run.id)
        touchedProjects.add(run.projectId)
      } catch (err) {
        result.skipped.push({
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // Après le commit d'`applyEvent`, jamais avant : un job envoyé sur un run
    // dont la transition serait annulée trouverait un état encore en pause.
    for (const runId of result.resumedRunIds) {
      try {
        await deps.enqueueRun(runId)
      } catch (err) {
        result.skipped.push({ runId, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  if (touchedProjects.size > 0) {
    await recordSample(deps.db, decision)
    // `budget.tick` n'est publié que pour les projets réellement touchés : le
    // type de l'événement exige un `projectId` (events/bus.ts), et un tick qui
    // ne change rien n'a rien à faire recharger au front.
    for (const projectId of touchedProjects) {
      eventBus.publish({ type: 'budget.tick', projectId })
    }
  }

  return result
}

/**
 * Trace la mesure qui a justifié un changement d'état, dans la table prévue
 * pour ça (`usage_windows`, migration 0001).
 *
 * Écrite UNIQUEMENT quand la décision bouge quelque chose : une ligne à chaque
 * tick ferait une série temporelle que personne ne lit et qu'aucune purge ne
 * nettoie. Ce qu'on veut garder, c'est de quoi répondre plus tard à « pourquoi
 * tout s'est arrêté à 14:37 ? ». Rien ne relit ces lignes pour décider — la
 * décision ne s'appuie que sur la mesure courante, cf. la note de tête.
 */
async function recordSample(db: Kysely<Database>, decision: BudgetDecision): Promise<void> {
  const gauge = decision.gauge
  if (!gauge) return
  const raw = JSON.stringify({
    action: decision.action,
    reason: decision.reason,
    effectivePct: gauge.pct,
    known: gauge.known,
  })
  await db
    .insertInto('usage_windows')
    .values([
      { window_kind: '5h', used_pct: String(gauge.fiveHourPct), raw },
      { window_kind: '7d', used_pct: String(gauge.sevenDayPct), raw },
    ])
    .execute()
}

/**
 * Item d'inbox non bloquant quand la jauge est muette alors que des boucles
 * tournent : sans lui, la protection budgétaire disparaîtrait en silence —
 * exactement le défaut qui a laissé `usage()` répondre `available: false`
 * pendant trois phases sans que personne ne le voie. Pas d'email, contrairement
 * au healthcheck d'auth : rien n'est cassé, la boucle avance toujours.
 */
async function raiseUnknownGaugeAlert(db: Kysely<Database>, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - ALERT_DEDUP_HOURS * 60 * 60 * 1000)
  const existing = await db
    .selectFrom('inbox_items')
    .select('id')
    .where('type', '=', 'alert')
    .where(sql<boolean>`payload->>'cause' = ${BUDGET_UNKNOWN_ALERT_KEY}`)
    .where(sql<boolean>`created_at > ${since}`)
    .executeTakeFirst()

  if (existing) return false

  await createInboxItem(db, {
    type: 'alert',
    title: 'Jauge de budget indisponible',
    fromRole: 'system',
    payload: {
      cause: BUDGET_UNKNOWN_ALERT_KEY,
      detail:
        "Le runtime ne rend plus de consommation : aucune boucle ne sera mise en pause tant que la jauge reste muette. La réserve n'est plus protégée.",
    },
    archiveToClient: false,
  })
  return true
}

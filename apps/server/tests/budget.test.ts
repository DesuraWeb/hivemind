import { randomUUID } from 'node:crypto'
import type { RunState } from '@silithid/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import {
  BUDGET_SETTINGS_KEYS,
  BUDGET_UNKNOWN_ALERT_KEY,
  type BudgetSettingsSource,
  DEFAULT_BUDGET_THRESHOLDS,
  decideBudget,
  loadBudgetThresholds,
  pauseThreshold,
  runBudgetTick,
  sanitizeThresholds,
} from '../src/budget/scheduler'
import { createSecretBox, generateMasterKey } from '../src/crypto/secrets'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedDefaultSettings } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import type { UsageSnapshot } from '../src/runtime/types'
import { createSettingsStore } from '../src/settings/store'

/**
 * Aucun de ces tests ne parle au SDK : la décision est pure, et `runBudgetTick`
 * prend une `usage()` simulée. La suite ne consomme donc pas un token — ce qui
 * est aussi vrai de la vraie sonde (cf. `runtime/usage.ts`), mais pour une
 * autre raison.
 */

const db = createDb(createPool(databaseUrl(loadEnv())))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
afterAll(async () => {
  await db.destroy()
})

const T = DEFAULT_BUDGET_THRESHOLDS
const PAUSE = pauseThreshold(T) // 85
const NOW = new Date('2026-08-13T14:00:00Z')

function snap(pct: number, ageMinutes = 0): UsageSnapshot {
  return {
    fiveHourPct: pct,
    sevenDayPct: 0,
    available: true,
    sampledAt: new Date(NOW.getTime() - ageMinutes * 60_000),
  }
}

// --- La décision, sans base ni réseau -------------------------------------

test('la reserve du pack DA fixe le seuil de pause : 100 − 15 = 85', () => {
  expect(PAUSE).toBe(85)
  expect(T.reservePct).toBe(15)
})

test('une jauge qui franchit le seuil demande une pause', () => {
  expect(decideBudget(snap(84), T, NOW).action).toBe('none')
  expect(decideBudget(snap(85), T, NOW).action).toBe('pause')
  expect(decideBudget(snap(97), T, NOW).action).toBe('pause')
})

test('une jauge qui redescend sous le seuil de reprise demande une reprise', () => {
  const decision = decideBudget(snap(40), T, NOW)
  expect(decision.action).toBe('resume')
  expect(decision.gauge?.known).toBe(true)
})

test('une oscillation autour du seuil ne produit ni pause ni reprise (hysteresis)', () => {
  // Le cas qui, sans bande morte, ferait battre la boucle à chaque tick.
  for (const pct of [84, 86, 84, 85, 83, 76]) {
    const action = decideBudget(snap(pct), T, NOW).action
    expect(action, `${pct} %`).toBe(pct >= PAUSE ? 'pause' : 'none')
  }
  // Il faut vraiment redescendre de 10 points sous le seuil pour repartir.
  expect(decideBudget(snap(75), T, NOW).action).toBe('resume')
})

test('une mesure perimee vaut jauge « inconnu » et derniere valeur majoree de 10 points', () => {
  const fresh = decideBudget(snap(78, 89), T, NOW)
  expect(fresh.gauge?.known).toBe(true)
  expect(fresh.gauge?.pct).toBe(78)
  expect(fresh.action).toBe('none')

  // Une minute de plus : la même mesure ne fait plus foi.
  const stale = decideBudget(snap(78, 91), T, NOW)
  expect(stale.gauge?.known).toBe(false)
  expect(stale.gauge?.pct).toBe(88)
  // Et la majoration suffit à franchir le seuil : c'est tout son intérêt.
  expect(stale.action).toBe('pause')
})

test('une mesure sans date est traitee comme perimee, jamais comme fraiche', () => {
  const decision = decideBudget({ fiveHourPct: 80, sevenDayPct: 0, available: true }, T, NOW)
  expect(decision.gauge?.known).toBe(false)
  expect(decision.gauge?.ageMinutes).toBeNull()
  expect(decision.gauge?.pct).toBe(90)
})

test('la majoration ne depasse jamais 100 points', () => {
  expect(decideBudget(snap(96, 120), T, NOW).gauge?.pct).toBe(100)
})

test('available: false ne met JAMAIS en pause, quel que soit le chiffre porte', () => {
  const decision = decideBudget({ fiveHourPct: 99, sevenDayPct: 99, available: false }, T, NOW)
  expect(decision.action).toBe('none')
  // Pas de jauge du tout : rien à majorer, rien à afficher.
  expect(decision.gauge).toBeNull()
})

test('aucune mesure du tout (premier tick, sonde muette) : ni pause ni reprise', () => {
  const decision = decideBudget(null, T, NOW)
  expect(decision.action).toBe('none')
  expect(decision.gauge).toBeNull()
})

test('la jauge retenue est le MAXIMUM des deux fenetres', () => {
  const decision = decideBudget(
    { fiveHourPct: 12, sevenDayPct: 91, available: true, sampledAt: NOW },
    T,
    NOW,
  )
  expect(decision.action).toBe('pause')
  expect(decision.gauge?.pct).toBe(91)
})

test('un reglage aberrant retombe sur le defaut plutot que de piloter une pause', () => {
  expect(sanitizeThresholds({ reservePct: 'beaucoup' }).reservePct).toBe(15)
  expect(sanitizeThresholds({ reservePct: 140 }).reservePct).toBe(15)
  expect(sanitizeThresholds({ stalenessMinutes: 0 }).stalenessMinutes).toBe(90)
  // Un seuil de reprise au-dessus du seuil de pause supprimerait l'hystérésis.
  const t = sanitizeThresholds({ reservePct: 20, resumePct: 95 })
  expect(t.resumePct).toBeLessThan(pauseThreshold(t))
})

// --- Le tick complet, avec de vrais runs ----------------------------------

const settings: BudgetSettingsSource = { get: async () => undefined }

async function createRun(state?: RunState, resumeState?: RunState): Promise<string> {
  const globe = await db.selectFrom('globes').select('id').executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'P',
      slug: `p-budget-${randomUUID()}`,
      repo_full_name: 'a/b',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'T', specs: '## S' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({
      step_id: step.id,
      ...(state ? { state } : {}),
      ...(resumeState ? { resume_state: resumeState } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return run.id
}

async function stateOf(runId: string): Promise<string> {
  const row = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  return row.state
}

function tick(usage: UsageSnapshot | null, enqueued: string[] = []) {
  return runBudgetTick({
    db,
    adapter: {
      usage: async () => usage ?? { fiveHourPct: 0, sevenDayPct: 0, available: false },
    },
    settings,
    enqueueRun: async (runId) => {
      enqueued.push(runId)
    },
    now: () => NOW,
  })
}

test('franchissement du seuil : les runs actifs passent en pause, les autres sont epargnes', async () => {
  const actif = await createRun()
  const humain = await createRun('awaiting_human', 'coding')
  const echoue = await createRun('failed')

  const first = await tick(snap(90))

  expect(first.decision.action).toBe('pause')
  expect(first.pausedRunIds).toEqual([actif])
  expect(first.skipped).toEqual([])
  expect(await stateOf(actif)).toBe('paused_budget')
  // Une attente humaine n'est jamais écrasée par une pause budgétaire, et un
  // run terminé n'est pas ressuscité pour être mis en pause.
  expect(await stateOf(humain)).toBe('awaiting_human')
  expect(await stateOf(echoue)).toBe('failed')

  // Second tick, même jauge : le run déjà en pause n'est pas repausé, et rien
  // n'échoue en travers — il n'est simplement plus dans la cible.
  const second = await tick(snap(90))
  expect(second.pausedRunIds).toEqual([])
  expect(second.skipped).toEqual([])

  // La mesure qui a justifié la pause est tracée, celle du tick sans effet ne
  // l'est pas.
  const samples = await db.selectFrom('usage_windows').selectAll().execute()
  expect(samples).toHaveLength(2)
  expect(samples.map((s) => s.window_kind).sort()).toEqual(['5h', '7d'])

  await sql`delete from usage_windows`.execute(db)
})

test('retour sous le seuil : le run repart et est re-enfile', async () => {
  const enqueued: string[] = []
  const enPause = await createRun('paused_budget', 'coding')

  const result = await tick(snap(50), enqueued)

  expect(result.decision.action).toBe('resume')
  expect(result.resumedRunIds).toContain(enPause)
  expect(await stateOf(enPause)).toBe('coding')
  // Sans ce ré-enfilage, le run repartirait en base sans que personne ne le
  // fasse avancer (jobs/run-step.ts : NO_REQUEUE_STATES).
  expect(enqueued).toContain(enPause)
})

test('une reprise impossible est signalee, jamais avalee en silence', async () => {
  // `resume_state` absent : la machine à états refuse la reprise.
  const casse = await createRun('paused_budget')

  const result = await tick(snap(50))

  expect(result.resumedRunIds).not.toContain(casse)
  expect(result.skipped.map((s) => s.runId)).toContain(casse)
  expect(await stateOf(casse)).toBe('paused_budget')

  await db.deleteFrom('runs').where('id', '=', casse).execute()
})

test('jauge indisponible : aucune pause, mais une alerte non bloquante, une seule fois', async () => {
  const actif = await createRun()

  const first = await tick(null)
  expect(first.decision.action).toBe('none')
  expect(first.pausedRunIds).toEqual([])
  expect(await stateOf(actif)).toBe('framing')
  expect(first.alerted).toBe(true)

  // Un cron toutes les 5 minutes noierait l'inbox sans dédoublonnage.
  const second = await tick(null)
  expect(second.alerted).toBe(false)

  const items = await db
    .selectFrom('inbox_items')
    .selectAll()
    .where(sql<boolean>`payload->>'cause' = ${BUDGET_UNKNOWN_ALERT_KEY}`)
    .execute()
  expect(items).toHaveLength(1)
  expect(items[0]?.type).toBe('alert')
})

test('les seuils viennent des reglages, pas du code', async () => {
  // Réserve portée à 40 : la pause tombe alors à 60 %, pas à 85 %.
  const custom: BudgetSettingsSource = {
    get: async (key) => (key === BUDGET_SETTINGS_KEYS.reservePct ? 40 : undefined),
  }
  const actif = await createRun()

  const result = await runBudgetTick({
    db,
    adapter: {
      usage: async () => snap(62),
    },
    settings: custom,
    enqueueRun: async () => {},
    now: () => NOW,
  })

  expect(result.decision.action).toBe('pause')
  expect(result.pausedRunIds).toContain(actif)
})

test('le seed pose les quatre seuils, et le vrai store les rend au scheduler', async () => {
  await seedDefaultSettings(db)
  const store = createSettingsStore(db, await createSecretBox(generateMasterKey()))

  // `SettingsStore` satisfait `BudgetSettingsSource` structurellement : c'est
  // ce qui permet à `startBoss` de n'exiger qu'une lecture de clés publiques.
  expect(await loadBudgetThresholds(store)).toEqual(DEFAULT_BUDGET_THRESHOLDS)

  // Un seuil ajusté à la main n'est pas réécrit par un second seed.
  await store.set(BUDGET_SETTINGS_KEYS.reservePct, 25)
  await seedDefaultSettings(db)
  expect((await loadBudgetThresholds(store)).reservePct).toBe(25)
})

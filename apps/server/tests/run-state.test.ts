import { RUN_STATES } from '@silithid/shared'
import type { RunState } from '@silithid/shared'
import { expect, test } from 'vitest'
import type { Decision, LoopEvent, RunContext } from '../src/domain/run-state'
import { decide } from '../src/domain/run-state'

// Contexte de base réutilisé par tous les tests ; chaque test ne surcharge
// que ce dont il a besoin pour rester lisible.
function baseCtx(overrides: Partial<RunContext> = {}): RunContext {
  // `resumeState` est omise par défaut (et non mise à `undefined`) : le
  // tsconfig active `exactOptionalPropertyTypes`, qui distingue « absente »
  // de « valant undefined » pour une propriété optionnelle.
  return {
    iteration: 1,
    maxIterations: 4,
    reviewRound: 0,
    maxReviewRounds: 3,
    autonomy: 'auto',
    ...overrides,
  }
}

const ALL_STATES: readonly RunState[] = RUN_STATES

const TERMINAL_STATES: readonly RunState[] = ['done', 'failed', 'stopped']

/** Les états depuis lesquels les événements génériques s'appliquent. */
const ACTIVE_STATES: readonly RunState[] = ALL_STATES.filter(
  (s) =>
    !['awaiting_human', 'paused_budget', 'paused_human', 'done', 'failed', 'stopped'].includes(s),
)

/** Tout ce qui n'est pas terminal : le domaine depuis lequel `aborted` doit aboutir. */
const NON_TERMINAL_STATES: readonly RunState[] = ALL_STATES.filter(
  (s) => !TERMINAL_STATES.includes(s),
)

// Une instance représentative par variante d'événement (`question` compte
// deux fois : bloquante et non bloquante ont des effets différents).
const ALL_EVENTS: readonly LoopEvent[] = [
  { type: 'frame_ready' },
  { type: 'pr_opened', prNumber: 1 },
  { type: 'review_ok' },
  { type: 'review_ko' },
  { type: 'ci_green' },
  { type: 'ci_red', reason: 'ci a échoué' },
  { type: 'judge_report' },
  { type: 'verdict_conforme' },
  { type: 'verdict_ecarts' },
  { type: 'question', blocking: true, fromRole: 'garant' },
  { type: 'question', blocking: false, fromRole: 'garant' },
  { type: 'human_resolved' },
  { type: 'budget_pause' },
  { type: 'budget_resume' },
  { type: 'manual_pause' },
  { type: 'manual_resume' },
  { type: 'aborted', reason: 'abandon manuel' },
]

// --- Cas nominaux, un test par règle du tableau du plan ---------------------

test('framing + frame_ready -> coding', () => {
  const d = decide('framing', { type: 'frame_ready' }, baseCtx())
  expect(d).toEqual({ kind: 'transition', to: 'coding', effects: [] })
})

test('coding + pr_opened -> reviewing', () => {
  const d = decide('coding', { type: 'pr_opened', prNumber: 42 }, baseCtx())
  expect(d).toEqual({ kind: 'transition', to: 'reviewing', effects: [] })
})

test('reviewing + review_ok -> deploying, reset_review_round', () => {
  const d = decide('reviewing', { type: 'review_ok' }, baseCtx({ reviewRound: 1 }))
  expect(d).toEqual({
    kind: 'transition',
    to: 'deploying',
    effects: [{ type: 'reset_review_round' }],
  })
})

test('reviewing + review_ko, round 0/3 -> coding, increment_review_round', () => {
  const d = decide(
    'reviewing',
    { type: 'review_ko' },
    baseCtx({ reviewRound: 0, maxReviewRounds: 3 }),
  )
  expect(d).toEqual({
    kind: 'transition',
    to: 'coding',
    effects: [{ type: 'increment_review_round' }],
  })
})

test('reviewing + review_ko, round 1/3 -> coding, increment_review_round', () => {
  const d = decide(
    'reviewing',
    { type: 'review_ko' },
    baseCtx({ reviewRound: 1, maxReviewRounds: 3 }),
  )
  expect(d).toEqual({
    kind: 'transition',
    to: 'coding',
    effects: [{ type: 'increment_review_round' }],
  })
})

test('reviewing + review_ko, round 2/3 -> awaiting_human + alert + remember_resume_state (decision A)', () => {
  const d = decide(
    'reviewing',
    { type: 'review_ko' },
    baseCtx({ reviewRound: 2, maxReviewRounds: 3 }),
  )
  expect(d.kind).toBe('transition')
  expect(d).toMatchObject({ kind: 'transition', to: 'awaiting_human' })
  const decision = d as Extract<Decision, { kind: 'transition' }>
  expect(decision.effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'open_inbox_item', itemType: 'alert' }),
      expect.objectContaining({ type: 'remember_resume_state', state: 'reviewing' }),
    ]),
  )
})

test('deploying + ci_green -> judging', () => {
  const d = decide('deploying', { type: 'ci_green' }, baseCtx())
  expect(d).toEqual({ kind: 'transition', to: 'judging', effects: [] })
})

test('deploying + ci_red -> awaiting_human + alert', () => {
  const d = decide('deploying', { type: 'ci_red', reason: 'tests rouges' }, baseCtx())
  expect(d).toMatchObject({ kind: 'transition', to: 'awaiting_human' })
  const decision = d as Extract<Decision, { kind: 'transition' }>
  expect(decision.effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'open_inbox_item', itemType: 'alert' }),
    ]),
  )
})

test('judging + judge_report -> verdict', () => {
  const d = decide('judging', { type: 'judge_report' }, baseCtx())
  expect(d).toEqual({ kind: 'transition', to: 'verdict', effects: [] })
})

test('verdict + verdict_conforme, gated -> awaiting_human + approval:step_end', () => {
  const d = decide('verdict', { type: 'verdict_conforme' }, baseCtx({ autonomy: 'gated' }))
  expect(d).toMatchObject({ kind: 'transition', to: 'awaiting_human' })
  const decision = d as Extract<Decision, { kind: 'transition' }>
  expect(decision.effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'open_inbox_item',
        itemType: 'approval',
        subtype: 'step_end',
      }),
    ]),
  )
})

test('verdict + verdict_conforme, auto -> done + end_run', () => {
  const d = decide('verdict', { type: 'verdict_conforme' }, baseCtx({ autonomy: 'auto' }))
  expect(d).toEqual({
    kind: 'transition',
    to: 'done',
    effects: [{ type: 'end_run', outcome: 'done' }],
  })
})

test('verdict + verdict_ecarts, iter 1/4 -> framing, increment_iteration, reset_review_round', () => {
  const d = decide(
    'verdict',
    { type: 'verdict_ecarts' },
    baseCtx({ iteration: 1, maxIterations: 4 }),
  )
  expect(d).toEqual({
    kind: 'transition',
    to: 'framing',
    effects: [{ type: 'increment_iteration' }, { type: 'reset_review_round' }],
  })
})

test('verdict + verdict_ecarts, iter 4/4 -> failed + alert + end_run', () => {
  const d = decide(
    'verdict',
    { type: 'verdict_ecarts' },
    baseCtx({ iteration: 4, maxIterations: 4 }),
  )
  expect(d).toMatchObject({ kind: 'transition', to: 'failed' })
  const decision = d as Extract<Decision, { kind: 'transition' }>
  expect(decision.effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'open_inbox_item', itemType: 'alert' }),
      expect.objectContaining({ type: 'end_run', outcome: 'failed' }),
    ]),
  )
})

test('etat actif + question bloquante -> awaiting_human, memorisation ET item inbox', () => {
  for (const state of ACTIVE_STATES) {
    const d = decide(state, { type: 'question', blocking: true, fromRole: 'garant' }, baseCtx())
    expect(d).toMatchObject({ kind: 'transition', to: 'awaiting_human' })
    if (d.kind !== 'transition') throw new Error('attendu : transition')
    expect(d.effects).toHaveLength(2)
  }
})

test('etat actif + question non bloquante -> stay + inbox question', () => {
  for (const state of [
    'framing',
    'coding',
    'design_wait',
    'reviewing',
    'deploying',
    'judging',
    'verdict',
  ] as const) {
    const d = decide(state, { type: 'question', blocking: false, fromRole: 'garant' }, baseCtx())
    expect(d.kind).toBe('stay')
    const decision = d as Extract<Decision, { kind: 'stay' }>
    expect(decision.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'open_inbox_item', itemType: 'question' }),
      ]),
    )
  }
})

test('awaiting_human + human_resolved -> ctx.resumeState, clear_resume_state', () => {
  const d = decide('awaiting_human', { type: 'human_resolved' }, baseCtx({ resumeState: 'coding' }))
  expect(d).toEqual({
    kind: 'transition',
    to: 'coding',
    effects: [{ type: 'clear_resume_state' }],
  })
})

test('etat actif + budget_pause -> paused_budget + remember_resume_state', () => {
  for (const state of [
    'framing',
    'coding',
    'design_wait',
    'reviewing',
    'deploying',
    'judging',
    'verdict',
  ] as const) {
    const d = decide(state, { type: 'budget_pause' }, baseCtx())
    expect(d).toEqual({
      kind: 'transition',
      to: 'paused_budget',
      effects: [{ type: 'remember_resume_state', state }],
    })
  }
})

test('paused_budget + budget_resume -> ctx.resumeState', () => {
  const d = decide('paused_budget', { type: 'budget_resume' }, baseCtx({ resumeState: 'judging' }))
  expect(d).toMatchObject({ kind: 'transition', to: 'judging' })
})

test('done / failed / stopped + tout evenement -> invalid', () => {
  for (const state of TERMINAL_STATES) {
    for (const event of ALL_EVENTS) {
      expect(decide(state, event, baseCtx()).kind).toBe('invalid')
    }
  }
})

test('awaiting_human + frame_ready -> invalid', () => {
  const d = decide('awaiting_human', { type: 'frame_ready' }, baseCtx({ resumeState: 'coding' }))
  expect(d.kind).toBe('invalid')
})

// --- Tests transverses : plus importants que les cas nominaux --------------

test('aucun evenement ne fait sortir d un etat terminal', () => {
  for (const state of TERMINAL_STATES) {
    for (const event of ALL_EVENTS) {
      expect(decide(state, event, baseCtx()).kind).toBe('invalid')
    }
  }
})

test('le gate step_end ne saute JAMAIS hors mode auto', () => {
  const d = decide('verdict', { type: 'verdict_conforme' }, baseCtx({ autonomy: 'gated' }))
  expect(d).toMatchObject({ kind: 'transition', to: 'awaiting_human' })
  const decision = d as Extract<Decision, { kind: 'transition' }>
  expect(decision.effects).toEqual(
    expect.arrayContaining([expect.objectContaining({ subtype: 'step_end' })]),
  )
})

test('une transition invalide ne produit jamais d effet', () => {
  let combos = 0
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      combos += 1
      const d = decide(state, event, baseCtx())
      if (d.kind === 'invalid') {
        expect(d).not.toHaveProperty('effects')
      }
    }
  }
  // ALL_STATES (13) x ALL_EVENTS (17) : le balayage doit couvrir toutes les
  // combinaisons état x événement, pas seulement quelques cas choisis à la main.
  // Les deux états et les deux événements du contrôle de run y sont inclus.
  expect(combos).toBe(ALL_STATES.length * ALL_EVENTS.length)
  expect(combos).toBe(13 * 17)
})

// --- Corrections apportées après relecture (brief §7 et §8) ---

test('une question bloquante ouvre AUSSI un item d inbox', () => {
  for (const state of ACTIVE_STATES) {
    const d = decide(state, { type: 'question', blocking: true, fromRole: 'garant' }, baseCtx())
    expect(d).toMatchObject({ kind: 'transition', to: 'awaiting_human' })
    if (d.kind !== 'transition') throw new Error('attendu : transition')

    // Sans l'item, le run attendrait sans que personne ne puisse le voir.
    expect(d.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'open_inbox_item', itemType: 'question' }),
      ]),
    )
    expect(d.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'remember_resume_state', state })]),
    )
  }
})

// --- Contrôle de run : pause manuelle, arrêt humain ---

test('aborted termine le run en stopped, jamais en failed', () => {
  for (const state of NON_TERMINAL_STATES) {
    const d = decide(state, { type: 'aborted', reason: 'stop humain' }, baseCtx())
    // Un arrêt décidé n'est PAS un échec : les confondre ferait lire « échec »
    // dans la liste des projets sur une décision volontaire.
    expect(d).toMatchObject({ kind: 'transition', to: 'stopped' })
    if (d.kind !== 'transition') throw new Error('attendu : transition')

    expect(d.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'end_run', outcome: 'stopped' })]),
    )
    // L'humain a décidé l'arrêt : il n'a pas à en être notifié.
    expect(d.effects.some((e) => e.type === 'open_inbox_item')).toBe(false)
  }
})

test('aborted aboutit AUSSI depuis awaiting_human et les deux pauses', () => {
  // Le geste attendu est « je suspends, je regarde, j'arrête » : si l'arrêt ne
  // marchait que depuis un état actif, il faudrait reprendre le run pour
  // pouvoir l'arrêter.
  for (const state of ['awaiting_human', 'paused_budget', 'paused_human'] as const) {
    const d = decide(state, { type: 'aborted', reason: 'stop humain' }, baseCtx())
    expect(d).toMatchObject({ kind: 'transition', to: 'stopped' })
  }
})

test('etat actif + manual_pause -> paused_human + remember_resume_state', () => {
  for (const state of ACTIVE_STATES) {
    const d = decide(state, { type: 'manual_pause' }, baseCtx())
    expect(d).toEqual({
      kind: 'transition',
      to: 'paused_human',
      effects: [{ type: 'remember_resume_state', state }],
    })
  }
})

test('paused_human + manual_resume -> ctx.resumeState, clear_resume_state', () => {
  const d = decide('paused_human', { type: 'manual_resume' }, baseCtx({ resumeState: 'coding' }))
  expect(d).toEqual({
    kind: 'transition',
    to: 'coding',
    effects: [{ type: 'clear_resume_state' }],
  })
})

test('paused_human + manual_resume sans resume_state -> invalid', () => {
  expect(decide('paused_human', { type: 'manual_resume' }, baseCtx()).kind).toBe('invalid')
})

test('le scheduler de budget ne peut PAS lever une pause manuelle', () => {
  // La garantie centrale du choix d'un état distinct. `budget/scheduler.ts`
  // envoie `budget_resume` à chaque tick où la jauge est sous le seuil de
  // reprise — c'est le cas nominal, pas l'exception. S'il atteignait un run
  // mis en pause à la main, il le relancerait dans les cinq minutes.
  const d = decide('paused_human', { type: 'budget_resume' }, baseCtx({ resumeState: 'coding' }))
  expect(d.kind).toBe('invalid')
})

test('une reprise manuelle ne leve PAS une pause budgetaire', () => {
  // La réciproque : sortir du budget se fait par le scheduler ou par le
  // déblocage de réserve, qui lèvent AUSSI le seuil. Une reprise manuelle
  // seule serait annulée au tick suivant.
  const d = decide('paused_budget', { type: 'manual_resume' }, baseCtx({ resumeState: 'coding' }))
  expect(d.kind).toBe('invalid')
})

test('manual_pause est refuse depuis awaiting_human et depuis une pause', () => {
  for (const state of ['awaiting_human', 'paused_budget', 'paused_human'] as const) {
    expect(decide(state, { type: 'manual_pause' }, baseCtx()).kind).toBe('invalid')
  }
})

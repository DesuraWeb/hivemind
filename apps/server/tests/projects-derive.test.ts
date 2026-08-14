import type { RunState } from '@silithid/shared'
import { expect, test } from 'vitest'
import {
  buildLine,
  deriveRole,
  formatConso,
  formatDuree,
  loopFromRunState,
} from '../src/projects/derive'

// --- loopFromRunState : chaque état de run couvert, plus l'absence de run ---

test('loopFromRunState : les 7 états actifs rendent tous "run"', () => {
  const active: RunState[] = [
    'framing',
    'coding',
    'design_wait',
    'reviewing',
    'deploying',
    'judging',
    'verdict',
  ]
  for (const state of active) {
    expect(loopFromRunState(state)).toBe('run')
  }
})

test('loopFromRunState : awaiting_human rend "wait"', () => {
  expect(loopFromRunState('awaiting_human')).toBe('wait')
})

test('loopFromRunState : paused_budget rend "pause"', () => {
  expect(loopFromRunState('paused_budget')).toBe('pause')
})

test('loopFromRunState : paused_human rend "pause" aussi', () => {
  // À l'échelle d'une ligne de liste, la seule chose qui compte est qu'un
  // geste humain soit attendu. La distinction budget/humain reste lisible sur
  // l'écran « Run en direct », qui rend `state` tel quel.
  expect(loopFromRunState('paused_human')).toBe('pause')
})

test('loopFromRunState : stopped rend "stop", JAMAIS "fail"', () => {
  // Un arrêt décidé est une décision, un échec est un constat. Les afficher
  // pareil ferait lire « échec » là où Florian a simplement coupé court.
  expect(loopFromRunState('stopped')).toBe('stop')
  expect(loopFromRunState('stopped')).not.toBe('fail')
})

test('loopFromRunState : failed rend "fail"', () => {
  expect(loopFromRunState('failed')).toBe('fail')
})

test('loopFromRunState : done rend "done"', () => {
  expect(loopFromRunState('done')).toBe('done')
})

test('loopFromRunState : un projet sans aucun run (state null) rend "pause"', () => {
  // Un projet neuf est une invitation à démarrer, pas une décision de pause :
  // les deux appellent des gestes opposés dans l'UI.
  expect(loopFromRunState(null)).toBe('demarrage')
})

// --- deriveRole ---

test('deriveRole : framing → garant, coding → dev, reviewing → reviewer', () => {
  expect(deriveRole('framing', null)).toBe('garant')
  expect(deriveRole('coding', null)).toBe('dev')
  expect(deriveRole('reviewing', null)).toBe('reviewer')
})

test('deriveRole : judging et verdict → juge (traduction FR de la clé judge)', () => {
  expect(deriveRole('judging', null)).toBe('juge')
  expect(deriveRole('verdict', null)).toBe('juge')
})

test('deriveRole : deploying → dev', () => {
  expect(deriveRole('deploying', null)).toBe('dev')
})

test('deriveRole : design_wait → aucun rôle des 6 définis (hors périmètre Phase 3)', () => {
  expect(deriveRole('design_wait', null)).toBeNull()
})

test('deriveRole : awaiting_human lit resume_state, pas l état courant', () => {
  expect(deriveRole('awaiting_human', 'framing')).toBe('garant')
  expect(deriveRole('awaiting_human', 'verdict')).toBe('juge')
})

test('deriveRole : paused_budget, done, failed et stopped n affichent personne au travail', () => {
  expect(deriveRole('paused_budget', 'coding')).toBeNull()
  expect(deriveRole('done', null)).toBeNull()
  expect(deriveRole('failed', null)).toBeNull()
  expect(deriveRole('stopped', 'coding')).toBeNull()
})

test('deriveRole : paused_human lit resume_state, pour dire QUI a ete interrompu', () => {
  // « tu as mis le dev en pause » se lit ; « pause » tout seul ne dit pas ce
  // qui a été interrompu.
  expect(deriveRole('paused_human', 'coding')).toBe('dev')
  expect(deriveRole('paused_human', 'framing')).toBe('garant')
})

test('deriveRole : un projet sans run (state null) n a pas de rôle', () => {
  expect(deriveRole(null, null)).toBeNull()
})

// --- formatConso ---

test('formatConso : 0 token rend le littéral "0 token"', () => {
  expect(formatConso(0, 15)).toBe('0 token')
})

test('formatConso : formate en k tokens et en euros, séparateur "·", virgule française', () => {
  // 200 000 tokens à 15 €/Mtok = 3,00 €.
  expect(formatConso(200_000, 15)).toBe('200,0 k tokens · 3,00 €')
})

test('formatConso : aucun tiret cadratin dans la chaîne rendue (règle DA stricte)', () => {
  expect(formatConso(200_000, 15)).not.toContain('—')
  expect(formatConso(0, 15)).not.toContain('—')
})

// --- formatDuree ---

test('formatDuree : "·" pour tout loop différent de "run"', () => {
  const started = new Date(Date.now() - 5 * 60_000)
  for (const loop of ['wait', 'fail', 'done', 'pause', 'demarrage', 'stop'] as const) {
    expect(formatDuree(loop, started)).toBe('·')
  }
})

test('formatDuree : "·" si loop="run" mais pas de run (startedAt null)', () => {
  expect(formatDuree('run', null)).toBe('·')
})

test('formatDuree : minutes écoulées pour un run actif', () => {
  const now = new Date('2026-08-12T10:14:00.000Z')
  const started = new Date('2026-08-12T10:00:00.000Z')
  expect(formatDuree('run', started, now)).toBe('14 min')
})

test('formatDuree : heures au-delà de 60 minutes', () => {
  const now = new Date('2026-08-12T12:05:00.000Z')
  const started = new Date('2026-08-12T10:00:00.000Z')
  expect(formatDuree('run', started, now)).toBe('2 h 5 min')
})

// --- buildLine : vérifiée champ à champ contre PROJECTS[] de data.js ---

test('buildLine : koin (run, dev, itér. 2/4, 14 min) — correspond exactement à data.js', () => {
  const line = buildLine({
    step: [4, 7],
    loop: 'run',
    role: 'dev',
    iteration: [2, 4],
    duree: '14 min',
    pending: [],
  })
  expect(line).toBe('step 4/7 · dev · itér. 2/4 · 14 min')
})

test('buildLine : reparea (wait, 1 question) — correspond exactement à data.js', () => {
  const line = buildLine({
    step: [2, 5],
    loop: 'wait',
    role: 'garant',
    iteration: null,
    duree: '·',
    pending: [{ type: 'question', n: 1 }],
  })
  expect(line).toBe('step 2/5 · en attente humain · 1 question')
})

test('buildLine : soleil (done) — correspond exactement à data.js', () => {
  const line = buildLine({
    step: [3, 3],
    loop: 'done',
    role: null,
    iteration: null,
    duree: '·',
    pending: [],
  })
  expect(line).toBe('step 3/3 · terminé')
})

test('buildLine : webmaster (pause) — correspond exactement à data.js', () => {
  const line = buildLine({
    step: [2, 6],
    loop: 'pause',
    role: null,
    iteration: null,
    duree: '·',
    pending: [],
  })
  expect(line).toBe('step 2/6 · pause')
})

test('buildLine : un run arrete se lit « arrêté », pas « échec »', () => {
  const line = buildLine({
    step: [3, 6],
    loop: 'stop',
    role: null,
    iteration: null,
    duree: '·',
    pending: [],
  })
  expect(line).toBe('step 3/6 · arrêté')
  expect(line).not.toContain('échec')
  // Règle DA stricte : le séparateur est « · », jamais un tiret cadratin.
  expect(line).not.toContain('—')
})

test('buildLine : calanques (fail, itér. 4/4) — correspond exactement à data.js', () => {
  const line = buildLine({
    step: [1, 3],
    loop: 'fail',
    role: 'dev',
    iteration: [4, 4],
    duree: '·',
    pending: [
      { type: 'alert', n: 1 },
      { type: 'question', n: 1 },
    ],
  })
  expect(line).toBe('step 1/3 · échec · itér. 4/4')
})

test('buildLine : aucun tiret cadratin dans les lignes rendues', () => {
  const line = buildLine({
    step: [1, 3],
    loop: 'wait',
    role: null,
    iteration: null,
    duree: '·',
    pending: [
      { type: 'verdict', n: 1 },
      { type: 'question', n: 1 },
    ],
  })
  expect(line).not.toContain('—')
})

test('la ligne d un projet neuf invite a lancer, elle ne constate pas un arret', () => {
  const line = buildLine({
    step: [1, 5],
    loop: 'demarrage',
    role: null,
    iteration: null,
    duree: '·',
    pending: [],
  })
  expect(line).toBe('step 1/5 · prêt à démarrer')
  // Règle DA stricte : séparateur « · », jamais de tiret cadratin.
  expect(line).not.toContain('—')
})

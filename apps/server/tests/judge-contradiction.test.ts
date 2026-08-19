import { expect, test } from 'vitest'
import type { StoredMessage } from '../src/loop/bus'
import { contredit, readJudgeSummary } from '../src/loop/judge-contradiction'

/** Fabrique un rapport de juge tel que `judging.ts` l'écrit dans le bus. */
function rapport(conformites: string[], ecarts: { severite: string }[]): StoredMessage[] {
  return [
    {
      id: '1',
      fromRole: 'judge',
      toRole: 'garant',
      kind: 'report',
      body: 'peu importe',
      meta: { conformites, ecarts },
      createdAt: new Date(),
    },
  ]
}

test('le motif exact : aucune conformite ET un bloquant, garant conforme', () => {
  // C'est le run reel du 15/08 : le juge capturait un 404, le garant a lu la
  // source et conclu juste. Bon verdict, juge en panne, panne invisible.
  const r = readJudgeSummary(rapport([], [{ severite: 'bloquant' }, { severite: 'mineur' }]))
  expect(r).toEqual({ conformites: 0, ecartsBloquants: 1, total: 2 })
  expect(contredit(r, 'conforme')).toBe(true)
})

test('un arbitrage ORDINAIRE ne declenche rien', () => {
  // Le garant ecarte un point que le juge a souleve : c'est son role, ca
  // arrive a chaque run. Lever un item la-dessus noierait le vrai signal.
  const partiel = readJudgeSummary(rapport(['un critere tenu'], [{ severite: 'bloquant' }]))
  expect(contredit(partiel, 'conforme')).toBe(false)

  // Aucun bloquant : le juge n'a rien refuse, il n'y a pas de contradiction.
  const sansBloquant = readJudgeSummary(rapport([], [{ severite: 'mineur' }]))
  expect(contredit(sansBloquant, 'conforme')).toBe(false)
})

test('un verdict « ecarts » ne declenche jamais : le garant SUIT le juge', () => {
  const r = readJudgeSummary(rapport([], [{ severite: 'bloquant' }]))
  expect(contredit(r, 'ecarts')).toBe(false)
})

test('un rapport sans metadonnees structurees ne fait rien deviner', () => {
  const ancien: StoredMessage[] = [
    {
      id: '1',
      fromRole: 'judge',
      toRole: 'garant',
      kind: 'report',
      body: 'texte libre',
      meta: {},
      createdAt: new Date(),
    },
  ]
  expect(readJudgeSummary(ancien)).toBeNull()
  expect(contredit(null, 'conforme')).toBe(false)
})

test('sans rapport de juge du tout, rien', () => {
  expect(readJudgeSummary([])).toBeNull()
})

test('le rapport le plus RECENT fait foi', () => {
  // Une iteration corrective produit un second rapport : c'est lui qui compte.
  const messages = [
    ...rapport([], [{ severite: 'bloquant' }]),
    { ...(rapport(['tout va bien'], [])[0] as StoredMessage), id: '2' },
  ]
  expect(readJudgeSummary(messages)?.conformites).toBe(1)
  expect(contredit(readJudgeSummary(messages), 'conforme')).toBe(false)
})

import { expect, test } from 'vitest'
import { createFakeAdapter } from '../src/runtime/fake'
import type { AgentEvent } from '../src/runtime/types'

const baseOpts = {
  roleKey: 'dev' as const,
  systemPrompt: 'Tu es un développeur.',
  cwd: '/tmp/worktree-test',
  tools: { bash: true, fs: 'write' as const, mcp: [] },
}

test('createSession renvoie une session identifiée', async () => {
  const adapter = createFakeAdapter()
  const session = await adapter.createSession({ ...baseOpts, onEvent: () => {} })

  expect(session.id).toMatch(/^fake-/)
  expect(session.roleKey).toBe('dev')
  expect(session.cwd).toBe('/tmp/worktree-test')
})

test('send renvoie la réponse scriptée et émet des évènements', async () => {
  const adapter = createFakeAdapter({ replies: ['première', 'deuxième'] })
  const events: AgentEvent[] = []
  const session = await adapter.createSession({ ...baseOpts, onEvent: (e) => events.push(e) })

  const first = await adapter.send(session, 'salut')
  expect(first.text).toBe('première')
  expect(first.isError).toBe(false)
  expect(first.costTokens).toBeGreaterThan(0)

  const second = await adapter.send(session, 'et ensuite ?')
  expect(second.text).toBe('deuxième')

  expect(events.some((e) => e.type === 'text')).toBe(true)
  expect(events.some((e) => e.type === 'cost')).toBe(true)
})

test('send au-delà du script renvoie une réponse par défaut', async () => {
  const adapter = createFakeAdapter({ replies: ['une seule'] })
  const session = await adapter.createSession({ ...baseOpts, onEvent: () => {} })
  await adapter.send(session, 'a')

  const overflow = await adapter.send(session, 'b')
  expect(overflow.text).toContain('[fake]')
})

test('resume retrouve une session existante, pas une inconnue', async () => {
  const adapter = createFakeAdapter()
  const session = await adapter.createSession({ ...baseOpts, onEvent: () => {} })

  expect(await adapter.resume(session.id)).toMatchObject({ id: session.id })
  expect(await adapter.resume('inconnue')).toBeNull()
})

test('usage se déclare indisponible par défaut', async () => {
  expect(await createFakeAdapter().usage()).toEqual({
    fiveHourPct: 0,
    sevenDayPct: 0,
    available: false,
  })
})

test('usage renvoie les valeurs injectées', async () => {
  const adapter = createFakeAdapter({ usage: { fiveHourPct: 80, sevenDayPct: 12 } })
  expect(await adapter.usage()).toEqual({ fiveHourPct: 80, sevenDayPct: 12, available: true })
})

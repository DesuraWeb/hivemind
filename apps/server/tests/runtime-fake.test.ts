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

test('usage renvoie les valeurs injectées, datées', async () => {
  const adapter = createFakeAdapter({ usage: { fiveHourPct: 80, sevenDayPct: 12 } })
  const usage = await adapter.usage()

  expect(usage).toMatchObject({ fiveHourPct: 80, sevenDayPct: 12, available: true })
  // Une mesure disponible est toujours datée : le scheduler (J12) en a besoin
  // pour appliquer sa règle de péremption à 90 minutes.
  expect(usage.sampledAt).toBeInstanceOf(Date)
})

test('une mesure indisponible n est jamais datée', async () => {
  const usage = await createFakeAdapter().usage()
  expect(usage.available).toBe(false)
  expect(usage.sampledAt).toBeUndefined()
})

test('healthcheck rapporte une latence dans les deux issues', async () => {
  expect(await createFakeAdapter().healthcheck()).toMatchObject({ ok: true, latencyMs: 0 })
  expect(await createFakeAdapter({ healthcheckError: 'boom' }).healthcheck()).toMatchObject({
    ok: false,
    latencyMs: 0,
    error: 'boom',
  })
})

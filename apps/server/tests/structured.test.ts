import { expect, test, vi } from 'vitest'
import { createFakeAdapter } from '../src/runtime/fake'
import { collectStructured, frameSchema } from '../src/runtime/structured'

const baseOpts = {
  roleKey: 'garant' as const,
  systemPrompt: 'Tu es le garant.',
  cwd: '/tmp/worktree-test',
  tools: { bash: false, fs: 'read' as const, mcp: [] },
}

const validFrame = {
  dev_prompt: 'x'.repeat(50 + 5), // ≥ 50 caractères, cf. frameSchema.dev_prompt.min(50)
  acceptance_criteria: ['le formulaire refuse un email invalide'],
  pages_to_judge: ['/login'],
}

test('texte libre puis charge valide : deux tentatives, jamais une troisième', async () => {
  const adapter = createFakeAdapter({
    replies: [
      "voici mon cadrage en prose, sans appeler d'outil",
      { toolUse: { name: 'submit_frame', input: validFrame } },
    ],
  })
  const sendSpy = vi.spyOn(adapter, 'send')
  const session = await adapter.createSession({ ...baseOpts, onEvent: () => {} })

  const frame = await collectStructured(adapter, session, 'Cadre ce step.', frameSchema, {
    toolName: 'submit_frame',
    toolDescription: 'Soumet le cadrage du step.',
  })

  expect(frame).toEqual(validFrame)
  expect(sendSpy).toHaveBeenCalledTimes(2)
})

test('le message de relance cite l erreur zod, pas juste "format invalide"', async () => {
  const adapter = createFakeAdapter({
    replies: ['prose', { toolUse: { name: 'submit_frame', input: validFrame } }],
  })
  const sendSpy = vi.spyOn(adapter, 'send')
  const session = await adapter.createSession({ ...baseOpts, onEvent: () => {} })

  await collectStructured(adapter, session, 'Cadre ce step.', frameSchema, {
    toolName: 'submit_frame',
    toolDescription: 'Soumet le cadrage du step.',
  })

  const secondCallPrompt = sendSpy.mock.calls[1]?.[1]
  expect(secondCallPrompt).toContain('submit_frame')
  expect(secondCallPrompt).toContain('texte libre')
})

test('une charge qui ne valide pas zod retente aussi, en citant l erreur de champ', async () => {
  const invalidFrame = { dev_prompt: 'trop court', acceptance_criteria: [], pages_to_judge: [] }
  const adapter = createFakeAdapter({
    replies: [
      { toolUse: { name: 'submit_frame', input: invalidFrame } },
      { toolUse: { name: 'submit_frame', input: validFrame } },
    ],
  })
  const sendSpy = vi.spyOn(adapter, 'send')
  const session = await adapter.createSession({ ...baseOpts, onEvent: () => {} })

  const frame = await collectStructured(adapter, session, 'Cadre ce step.', frameSchema, {
    toolName: 'submit_frame',
    toolDescription: 'Soumet le cadrage du step.',
  })

  expect(frame).toEqual(validFrame)
  expect(sendSpy).toHaveBeenCalledTimes(2)
  const retryPrompt = sendSpy.mock.calls[1]?.[1]
  // L'erreur citée doit porter sur le champ en défaut (`dev_prompt` trop
  // court), pas un message générique.
  expect(retryPrompt).toContain('dev_prompt')
})

test('la boucle a une borne dure : jamais plus de maxAttempts appels, puis une erreur explicite', async () => {
  const adapter = createFakeAdapter({
    replies: ['prose 1', 'prose 2', 'prose 3', 'prose 4'],
  })
  const sendSpy = vi.spyOn(adapter, 'send')
  const session = await adapter.createSession({ ...baseOpts, onEvent: () => {} })

  await expect(
    collectStructured(adapter, session, 'Cadre ce step.', frameSchema, {
      toolName: 'submit_frame',
      toolDescription: 'Soumet le cadrage du step.',
      maxAttempts: 3,
    }),
  ).rejects.toThrow(/3 tentatives/)

  expect(sendSpy).toHaveBeenCalledTimes(3)
})

test('un seul essai suffit quand la premiere reponse est deja un appel d outil valide', async () => {
  const adapter = createFakeAdapter({
    replies: [{ toolUse: { name: 'submit_frame', input: validFrame } }],
  })
  const sendSpy = vi.spyOn(adapter, 'send')
  const session = await adapter.createSession({ ...baseOpts, onEvent: () => {} })

  const frame = await collectStructured(adapter, session, 'Cadre ce step.', frameSchema, {
    toolName: 'submit_frame',
    toolDescription: 'Soumet le cadrage du step.',
  })

  expect(frame).toEqual(validFrame)
  expect(sendSpy).toHaveBeenCalledTimes(1)
})

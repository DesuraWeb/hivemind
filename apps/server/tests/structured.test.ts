import { expect, test, vi } from 'vitest'
import { createFakeAdapter } from '../src/runtime/fake'
import { collectStructured, frameSchema, verdictSchema } from '../src/runtime/structured'

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

// --- Candidats-savoirs dans le verdict (Phase 7, Task 3) ---

const verdictNu = { decision: 'conforme' as const, ecarts: [] }
const candidat = {
  sujet: 'version PHP · PrestaShop',
  contenu: 'Les PrestaShop de ce client tournent en PHP 8.1 maximum, vérifier avant mise à jour.',
  cercle: 'globe' as const,
}

test('un verdict sans savoirs reste valide : ne rien apprendre est le cas normal', () => {
  const parsed = verdictSchema.parse(verdictNu)
  // Clé ABSENTE, pas `undefined` : un run qui n'apprend rien ne produit pas
  // un champ vide que l'appelant devrait ensuite distinguer.
  expect('savoirs' in parsed).toBe(false)
})

test('un candidat ne peut pas nommer une instance de cercle', () => {
  const parsed = verdictSchema.parse({
    ...verdictNu,
    savoirs: [{ ...candidat, cercle_id: 'globe-d-un-autre' }],
  })
  // Le champ n'existe pas au contrat : il est jeté, jamais transporté. C'est
  // le serveur qui résout l'instance depuis le projet du run.
  expect(parsed.savoirs?.[0]).not.toHaveProperty('cercle_id')
})

test('au-delà de trois savoirs, la charge est refusée', () => {
  const quatre = [1, 2, 3, 4].map((n) => ({ ...candidat, sujet: `sujet ${n}` }))
  expect(verdictSchema.safeParse({ ...verdictNu, savoirs: quatre }).success).toBe(false)
})

test('un sujet rédigé en phrase est refusé : il ne détecterait aucun conflit', () => {
  const bavard = { ...candidat, sujet: 'a'.repeat(81) }
  expect(verdictSchema.safeParse({ ...verdictNu, savoirs: [bavard] }).success).toBe(false)
})

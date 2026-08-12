import { expect, test } from 'vitest'
import { resolveToolPolicy } from '../src/runtime/tools'

test('fs: none n autorise aucun outil de fichier', () => {
  const r = resolveToolPolicy({ bash: false, fs: 'none', mcp: [] })
  expect(r.allowed).not.toContain('Read')
  expect(r.allowed).not.toContain('Write')
  expect(r.allowed).not.toContain('Bash')
})

test('fs: read autorise la lecture, jamais l ecriture', () => {
  const r = resolveToolPolicy({ bash: false, fs: 'read', mcp: [] })
  expect(r.allowed).toContain('Read')
  expect(r.allowed).not.toContain('Write')
  expect(r.allowed).not.toContain('Edit')
})

test('bash: false exclut Bash de la surface, pas seulement de l allowlist', () => {
  const r = resolveToolPolicy({ bash: true, fs: 'write', mcp: [] })
  expect(r.allowed).toContain('Bash')
  const denied = resolveToolPolicy({ bash: false, fs: 'write', mcp: [] })
  expect(denied.allowed).not.toContain('Bash')
  // `tools` est le champ que le SDK utilise réellement pour restreindre la
  // surface d'outils disponibles (voir sdk.d.ts, cité en tête de tools.ts) ;
  // `allowedTools` ne fait que dispenser du prompt de permission.
  expect(denied.sdkOptions).toMatchObject({ tools: expect.not.arrayContaining(['Bash']) })
})

test('les outils MCP sont prefixes et limites a l allowlist', () => {
  const r = resolveToolPolicy({ bash: false, fs: 'none', mcp: ['client_kb'] })
  expect(r.allowed.some((t) => t.includes('client_kb'))).toBe(true)
  expect(r.allowed.some((t) => t.includes('gmail'))).toBe(false)
})

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import {
  CLIENT_KB_MCP_SERVER,
  assertReadOnlyKbPolicy,
  createClientKbSurface,
  readPolicyMcp,
  roleUsesClientKb,
} from '../src/knowledge/client-kb'

/**
 * Aucun token : on verifie la surface MCP et la lecture de politique, pas le
 * comportement d'un agent.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})

afterAll(async () => {
  await db.destroy()
})

test('la politique jsonb est lue defensivement, jamais au prix d un run', () => {
  // La colonne est du jsonb : sa forme n'est garantie par personne.
  expect(readPolicyMcp({ mcp: ['client_kb', 'bus'] })).toEqual(['client_kb', 'bus'])
  expect(readPolicyMcp({ mcp: 'client_kb' })).toEqual([])
  expect(readPolicyMcp({ mcp: [1, 'bus', null] })).toEqual(['bus'])
  expect(readPolicyMcp({})).toEqual([])
  expect(readPolicyMcp(null)).toEqual([])
  expect(readPolicyMcp('nimporte quoi')).toEqual([])
})

test('seuls les roles qui declarent client_kb recoivent la surface', () => {
  expect(roleUsesClientKb({ mcp: ['client_kb', 'bus'] })).toBe(true)
  // Le juge et le reviewer ne l'ont pas : ils ne posent pas de question.
  expect(roleUsesClientKb({ mcp: ['bus'] })).toBe(false)
})

test('la fiche client est en LECTURE SEULE, et la garde est sur le chemin de production', () => {
  expect(() => assertReadOnlyKbPolicy(['client_kb', 'bus'])).not.toThrow()
  // Un savoir se pose par une reponse humaine en inbox, jamais par un agent
  // qui deciderait tout seul de ce qui est vrai d'un client.
  expect(() => assertReadOnlyKbPolicy(['client_kb_write'])).toThrow(/lecture seule/)
  expect(() => createClientKbSurface({ db, tools: { mcp: ['client_kb_write'] } })).toThrow()
})

test("la surface n'expose QUE lookup", () => {
  const surface = createClientKbSurface({ db, tools: { mcp: ['client_kb'] } })
  expect(surface.toolNames).toEqual(['lookup'])
  expect(surface.sendOptions.extraAllowedTools).toEqual([`mcp__${CLIENT_KB_MCP_SERVER}__lookup`])
  // Aucun outil d'ecriture, sous aucun nom.
  const callable = new Set(surface.sendOptions.extraAllowedTools ?? [])
  for (const forbidden of [
    `mcp__${CLIENT_KB_MCP_SERVER}__write`,
    `mcp__${CLIENT_KB_MCP_SERVER}__update`,
    `mcp__${CLIENT_KB_MCP_SERVER}__add_note`,
  ]) {
    expect(callable.has(forbidden)).toBe(false)
  }
})

test('aucune valeur de secret ne peut sortir par la fiche', async () => {
  await db
    .insertInto('clients')
    .values({
      name: `Bastide ${randomUUID().slice(0, 6)}`,
      tone: 'Direct, vouvoiement.',
      notes: JSON.stringify([{ q: 'Qui valide ?', a: 'Marie directement.' }]),
      secrets: JSON.stringify({ ssh_password: 'NE-DOIT-JAMAIS-SORTIR' }),
    })
    .execute()

  // `render` passe par `clients/repo.ts`, qui ne rend que les NOMS des acces.
  // Un agent qui pourrait lire un mot de passe n'aurait plus besoin de coffre.
  const { listClients } = await import('../src/clients/repo')
  const fiches = await listClients(db)
  expect(JSON.stringify(fiches)).not.toContain('NE-DOIT-JAMAIS-SORTIR')
  expect(fiches[0]?.accessKeys).toEqual(['ssh_password'])
})

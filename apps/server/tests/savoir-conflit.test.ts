import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import {
  CONFLIT_INBOX_SUBTYPE,
  leverConflit,
  normaliserSujet,
  resoudreConflit,
  trouverConflit,
} from '../src/knowledge/conflict'
import { rappeler } from '../src/knowledge/recall'
import { archiver, historique } from '../src/knowledge/store'
import { ensureGlobe } from './fixtures'

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
afterAll(async () => {
  await db.destroy()
})
beforeEach(async () => {
  await db.deleteFrom('inbox_items').execute()
  await db.deleteFrom('savoirs').execute()
})

test('deux savoirs de meme sujet dans le meme cercle se contredisent', async () => {
  await archiver(db, { cercle: 'hive', sujet: 'version PHP', contenu: 'PHP 8.1 max.' })
  const trouve = await trouverConflit(db, { cercle: 'hive', cercleId: null }, 'version PHP')
  expect(trouve?.contenu).toBe('PHP 8.1 max.')
})

test('la comparaison ignore casse et accents : un doublon ne passe pas', async () => {
  await archiver(db, { cercle: 'hive', sujet: 'Procédure  de  Validation', contenu: 'x' })
  // Laisser passer un doublon a cause d'une majuscule creerait exactement le
  // desordre que cette detection existe pour eviter.
  expect(
    await trouverConflit(db, { cercle: 'hive', cercleId: null }, 'procedure de validation'),
  ).not.toBeNull()
  expect(normaliserSujet('Procédure  de  Validation')).toBe('procedure de validation')
})

test('DEUX CERCLES DIFFERENTS ne se contredisent JAMAIS', async () => {
  const globe = await ensureGlobe(db)
  await archiver(db, { cercle: 'hive', sujet: 'version PHP', contenu: 'PHP 8.1 max.' })

  // « PHP 8.1 au globe » et « PHP 8.3 chez ce client » n'est pas un conflit :
  // c'est le mecanisme nominal de la cascade, ou le plus specifique gagne.
  // Lever un item la-dessus noierait les vrais conflits.
  const conflit = await trouverConflit(db, { cercle: 'globe', cercleId: globe.id }, 'version PHP')
  expect(conflit).toBeNull()
})

test('un savoir archive ne peut plus entrer en conflit', async () => {
  const s = await archiver(db, { cercle: 'hive', sujet: 'perime', contenu: 'obsolete' })
  await db.updateTable('savoirs').set({ etat: 'archive' }).where('id', '=', s.id).execute()
  expect(await trouverConflit(db, { cercle: 'hive', cercleId: null }, 'perime')).toBeNull()
})

test("l'item porte les DEUX textes, et avoue les limites de la detection", async () => {
  const existant = await archiver(db, {
    cercle: 'hive',
    sujet: 'version PHP',
    contenu: 'PHP 8.1 max.',
  })
  await leverConflit(db, {
    existant,
    propose: { sujet: 'version PHP', contenu: 'PHP 8.3 depuis juin.' },
  })

  const item = await db
    .selectFrom('inbox_items')
    .select(['type', 'subtype', 'payload'])
    .where('subtype', '=', CONFLIT_INBOX_SUBTYPE)
    .executeTakeFirstOrThrow()

  expect(item.type).toBe('approval')
  const p = item.payload as Record<string, { contenu?: string }> & { ctx: string }
  // Decider de memoire produit une mauvaise decision : les deux textes sont la.
  expect(p.existant?.contenu).toBe('PHP 8.1 max.')
  expect(p.propose?.contenu).toBe('PHP 8.3 depuis juin.')
  // Un mecanisme qui se presenterait comme exhaustif ferait baisser la garde
  // de celui qui le lit — c'est pire que pas de detection du tout.
  expect(p.ctx).toContain('ne seront PAS confrontés')
})

test('remplacer produit une VERSION, jamais une seconde entree concurrente', async () => {
  const existant = await archiver(db, {
    cercle: 'hive',
    sujet: 'version PHP',
    contenu: 'PHP 8.1 max.',
  })
  const apres = await resoudreConflit(db, existant.racineId, { action: 'remplacer' }, 'PHP 8.3.')

  expect(apres?.version).toBe(2)
  expect(await historique(db, existant.racineId)).toHaveLength(2)
  // Sans ca, resoudre un conflit en creerait un second.
  const actifs = await db.selectFrom('savoirs').select('id').where('etat', '=', 'actif').execute()
  expect(actifs).toHaveLength(1)
  expect((await rappeler(db, {}))[0]?.contenu).toBe('PHP 8.3.')
})

test('fusionner archive la formulation de l humain, pas celle de l agent', async () => {
  const existant = await archiver(db, { cercle: 'hive', sujet: 'x', contenu: 'ancien' })
  const apres = await resoudreConflit(
    db,
    existant.racineId,
    { action: 'fusionner', contenu: 'la synthese de Florian' },
    'la proposition de l agent',
  )
  expect(apres?.contenu).toBe('la synthese de Florian')
})

test("garder n'ecrit rien : la proposition est abandonnee", async () => {
  const existant = await archiver(db, { cercle: 'hive', sujet: 'x', contenu: 'ancien' })
  expect(await resoudreConflit(db, existant.racineId, { action: 'garder' }, 'ignore')).toBeNull()

  const h = await historique(db, existant.racineId)
  expect(h).toHaveLength(1)
  expect(h[0]?.contenu).toBe('ancien')
})

test('un cercle vide ne trouve aucun conflit', async () => {
  const globe = await ensureGlobe(db)
  expect(
    await trouverConflit(db, { cercle: 'globe', cercleId: globe.id }, 'quoi que ce soit'),
  ).toBeNull()
  expect(await trouverConflit(db, { cercle: 'client', cercleId: randomUUID() }, 'x')).toBeNull()
})

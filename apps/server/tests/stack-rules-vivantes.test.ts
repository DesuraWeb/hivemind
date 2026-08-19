import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { fusionner, savoirsDeStack } from '../src/knowledge/stack-rules'
import { archiver, archiverDefinitivement } from '../src/knowledge/store'

/**
 * `hive.stack_rules` etait une memoire morte : ecrite une fois, jamais
 * modifiee. Ces tests verifient qu'un savoir appris la rejoint — et surtout
 * qu'il ne va nulle part ailleurs.
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
beforeEach(async () => {
  await db.deleteFrom('savoirs').execute()
})

test('un savoir de stack rejoint les regles du projet concerne', async () => {
  await archiver(db, {
    cercle: 'hive',
    sujet: 'sitemap',
    contenu: 'Preremplir sitemap.xml avant la bascule DNS.',
    stack: 'astro',
  })

  // « Astro 5 » declenche la regle `astro` : comparaison en minuscules, par
  // inclusion, la meme que le socle statique.
  const pour = await savoirsDeStack(db, 'Astro 5')
  expect(pour).toHaveLength(1)
  expect(pour[0]).toContain('sitemap.xml')
})

test("un savoir de stack ne fuit PAS vers un projet d'une autre stack", async () => {
  await archiver(db, {
    cercle: 'hive',
    sujet: 'core',
    contenu: 'Ne jamais toucher au core.',
    stack: 'prestashop',
  })
  // Meler des contraintes PrestaShop a un projet WordPress ferait payer des
  // tokens pour du hors-sujet, et diluerait ce qui compte.
  expect(await savoirsDeStack(db, 'WordPress 6')).toEqual([])
  expect(await savoirsDeStack(db, null)).toEqual([])
})

test('un savoir SANS stack ne part dans aucune injection de stack', async () => {
  await archiver(db, { cercle: 'hive', sujet: 'commits', contenu: 'Messages courts.' })
  expect(await savoirsDeStack(db, 'Astro')).toEqual([])
})

test("un savoir d'un autre cercle ne devient jamais une regle de stack", async () => {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'G', slug: `g-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  // Une contrainte propre a UN globe n'a pas a devenir une regle transverse :
  // seul le cercle racine `hive` alimente les regles de stack.
  await archiver(db, {
    cercle: 'globe',
    cercleId: globe.id,
    sujet: 'sitemap',
    contenu: 'propre a ce globe',
    stack: 'astro',
  })
  expect(await savoirsDeStack(db, 'Astro')).toEqual([])
})

test('un savoir archive cesse d alimenter les regles', async () => {
  const s = await archiver(db, {
    cercle: 'hive',
    sujet: 'obsolete',
    contenu: 'plus vrai',
    stack: 'laravel',
  })
  expect(await savoirsDeStack(db, 'Laravel 12')).toHaveLength(1)
  await archiverDefinitivement(db, s.racineId)
  expect(await savoirsDeStack(db, 'Laravel 12')).toEqual([])
})

test('l appris S AJOUTE au socle, il ne l ecrase jamais', () => {
  const socle = '- On ne touche jamais au core.'
  const fusion = fusionner(socle, ['- PHP 8.1 max sur ce parc.'])

  expect(fusion).toContain('On ne touche jamais au core')
  expect(fusion).toContain('PHP 8.1 max')
  // Les deux blocs restent etiquetes : une regle posee par Florian n'a pas le
  // meme poids qu'une observation tiree d'un run, et les confondre
  // empecherait de corriger la bonne.
  expect(fusion).toContain('## Appris sur cette stack')

  // Cas degrades : ni socle ni appris ne doit pas produire un bloc vide.
  expect(fusionner(null, [])).toBeNull()
  expect(fusionner(socle, [])).toBe(socle)
  expect(fusionner(null, ['- seul'])).toContain('Appris')
})

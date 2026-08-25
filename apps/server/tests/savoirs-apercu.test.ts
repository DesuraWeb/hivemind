import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { apercuMemoire } from '../src/knowledge/apercu'
import { archiver, corriger } from '../src/knowledge/store'
import { ensureGlobe } from './fixtures'

/**
 * L'aperçu de la mémoire, qui alimente `/conscience`.
 *
 * L'écran DÉCLARAIT que la conscience collective n'existait pas, alors que la
 * Phase 7 l'avait livrée. C'est la faute inverse de celle que ce dépôt évite,
 * et elle coûte autant. Le dernier test de ce fichier existe pour qu'elle ne
 * revienne pas.
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
  await db.deleteFrom('emprunts_savoir').execute()
})

test('une mémoire vide est un ÉTAT, pas une panne', async () => {
  const a = await apercuMemoire(db)
  expect(a.actifs).toBe(0)
  expect(a.plusUtile).toBeNull()
  // Les quatre cercles sont rendus quand même : leur absence de contenu est
  // une information, leur absence de ligne serait une omission.
  expect(a.cercles.map((c) => c.cercle)).toEqual(['projet', 'client', 'globe', 'hive'])
})

test('`hive` n’a pas d’instance, et le dit par `null` plutôt que par zéro', async () => {
  const a = await apercuMemoire(db)
  // Zéro laisserait croire à un cercle vide · la question de l'instance ne se
  // pose pas pour hive, il est unique.
  expect(a.cercles.find((c) => c.cercle === 'hive')?.instances).toBeNull()
  expect(a.cercles.find((c) => c.cercle === 'globe')?.instances).toBe(0)
})

test('les comptes suivent la mémoire réelle, cercle par cercle', async () => {
  const globe = await ensureGlobe(db)
  await archiver(db, {
    cercle: 'hive',
    sujet: 'matomo',
    contenu: 'Matomo auto-hébergé, jamais GA.',
  })
  await archiver(db, {
    cercle: 'globe',
    cercleId: globe.id,
    sujet: 'charte',
    contenu: 'Lavande et crème, jamais de dégradé.',
  })
  await sql`update savoirs set rappels = 7 where sujet = 'charte'`.execute(db)

  const a = await apercuMemoire(db)
  expect(a.actifs).toBe(2)
  expect(a.cercles.find((c) => c.cercle === 'globe')).toMatchObject({
    actifs: 1,
    instances: 1,
    rappels: 7,
  })
  expect(a.plusUtile).toMatchObject({ sujet: 'charte', cercle: 'globe', rappels: 7 })
  // Un savoir jamais rappelé est la mesure qui compte : il est soit faux, soit
  // inutile, et dans les deux cas il doit remonter.
  expect(a.jamaisRappeles).toBe(1)
})

test('une correction crée une version et ne perd pas l’ancienne', async () => {
  const s = await archiver(db, { cercle: 'hive', sujet: 'matomo', contenu: 'Matomo auto-hébergé.' })
  await corriger(db, s.racineId, 'Matomo auto-hébergé · jamais Google Analytics ni Plausible.')

  const a = await apercuMemoire(db)
  // Un actif, une version archivée · rien n'est écrasé.
  expect(a.actifs).toBe(1)
  expect(a.versions).toBe(1)
})

test('les deux mémoires de stack sont comptées séparément', async () => {
  await archiver(db, {
    cercle: 'hive',
    sujet: 'eager',
    contenu: 'Eager loading par défaut.',
    stack: 'laravel',
    domaine: 'code',
  })
  await archiver(db, {
    cercle: 'hive',
    sujet: 'robots',
    contenu: 'robots.txt dès le premier déploiement.',
    stack: 'astro',
    domaine: 'exploitation',
  })

  const a = await apercuMemoire(db)
  // Les mêler ferait croire à un dev qu'il doit penser au robots.txt, et à
  // l'agent ops qu'il doit penser au eager loading.
  expect(a.stack).toEqual({ code: 1, exploitation: 1 })
})

test('un emprunt actif est compté par mode', async () => {
  const globeA = await ensureGlobe(db)
  const globeB = await db
    .insertInto('globes')
    .values({ name: `Globe ${randomUUID().slice(0, 6)}`, slug: `g-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const s = await archiver(db, {
    cercle: 'globe',
    cercleId: globeA.id,
    sujet: 'x',
    contenu: 'yyyyyyyyyyyy',
  })
  await db
    .insertInto('emprunts_savoir')
    .values({
      globe_emprunteur_id: globeB.id,
      globe_preteur_id: globeA.id,
      savoir_racine_id: s.racineId,
      mode: 'lecture',
    })
    .execute()

  const a = await apercuMemoire(db)
  expect(a.emprunts).toEqual({ actifs: 1, lecture: 1, fork: 0 })
})

test('l’écran /conscience ne déclare plus que la mémoire n’existe pas', async () => {
  const chemin = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../web/src/routes/Conscience.tsx',
  )
  const source = await readFile(chemin, 'utf8')

  // Le texte exact que l'écran RENDAIT, et qui était faux depuis la Phase 7.
  // Ce test tombe si quelqu'un le remet, dans le rendu comme dans un
  // commentaire mal recopié.
  const rendu = source.replace(/\/\*\*[\s\S]*?\*\//g, '')
  expect(rendu).not.toMatch(/la conscience collective n['’]existe pas/i)
  expect(rendu).not.toMatch(/aucune table de savoirs/i)

  // Et il lit bien la mémoire au lieu de la décrire.
  expect(source).toContain('api.savoirs.apercu')
})

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import {
  EMPRUNT_INBOX_SUBTYPE,
  accorderEmprunt,
  demanderEmprunt,
  revoquerEmprunt,
  savoirsEmpruntes,
} from '../src/knowledge/borrow'
import { rappeler } from '../src/knowledge/recall'
import { archiver, corriger } from '../src/knowledge/store'

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
  await db.deleteFrom('emprunts_savoir').execute()
  await db.deleteFrom('inbox_items').execute()
  await db.deleteFrom('savoirs').execute()
})

async function deuxGlobes() {
  const a = await db
    .insertInto('globes')
    .values({ name: 'Desura', slug: `desura-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const b = await db
    .insertInto('globes')
    .values({ name: 'Perso', slug: `perso-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { preteur: a.id, emprunteur: b.id }
}

test('LES GLOBES SONT ETANCHES : le rappel ne traverse jamais', async () => {
  const { preteur, emprunteur } = await deuxGlobes()
  await archiver(db, {
    cercle: 'globe',
    cercleId: preteur,
    sujet: 'conventions Docker',
    contenu: 'compose v2 partout',
  })
  // Sans emprunt, rien ne passe. C'est ce qui rend l'etancheite reelle
  // plutot que declarative.
  expect(await rappeler(db, { globeId: emprunteur })).toEqual([])
})

test('la demande passe par l inbox, elle n accorde rien', async () => {
  const { preteur, emprunteur } = await deuxGlobes()
  const s = await archiver(db, {
    cercle: 'globe',
    cercleId: preteur,
    sujet: 'conventions Docker',
    contenu: 'compose v2',
  })
  await demanderEmprunt(db, {
    globeEmprunteurId: emprunteur,
    globePreteurId: preteur,
    savoirRacineId: s.racineId,
    motif: 'le blog photo en a besoin',
  })

  const item = await db
    .selectFrom('inbox_items')
    .select(['type', 'subtype', 'payload'])
    .where('subtype', '=', EMPRUNT_INBOX_SUBTYPE)
    .executeTakeFirstOrThrow()
  expect(item.type).toBe('approval')
  const p = item.payload as { ctx: string }
  expect(p.ctx).toContain('Perso → globe Desura')
  expect(p.ctx).toContain('le blog photo en a besoin')
  // L'item doit expliquer que les deux issues ne durent pas pareil.
  expect(p.ctx).toContain('survit à la révocation')

  // Et surtout : rien n'est accorde tant que personne n'a decide.
  expect(await savoirsEmpruntes(db, emprunteur)).toEqual([])
  expect(await db.selectFrom('emprunts_savoir').select('id').execute()).toEqual([])
})

test('une LECTURE suit les corrections du preteur', async () => {
  const { preteur, emprunteur } = await deuxGlobes()
  const s = await archiver(db, {
    cercle: 'globe',
    cercleId: preteur,
    sujet: 'docker',
    contenu: 'v1',
  })
  await accorderEmprunt(
    db,
    { globeEmprunteurId: emprunteur, globePreteurId: preteur, savoirRacineId: s.racineId },
    'lecture',
  )

  expect((await savoirsEmpruntes(db, emprunteur))[0]?.contenu).toBe('v1')
  await corriger(db, s.racineId, 'v2 corrigee par le preteur')
  // C'est ce qui distingue une lecture d'une copie : on partage une verite.
  expect((await savoirsEmpruntes(db, emprunteur))[0]?.contenu).toBe('v2 corrigee par le preteur')
})

test('une LECTURE revoquee cesse d etre vue', async () => {
  const { preteur, emprunteur } = await deuxGlobes()
  const s = await archiver(db, { cercle: 'globe', cercleId: preteur, sujet: 'x', contenu: 'y' })
  await accorderEmprunt(
    db,
    { globeEmprunteurId: emprunteur, globePreteurId: preteur, savoirRacineId: s.racineId },
    'lecture',
  )
  await revoquerEmprunt(db, emprunteur, s.racineId)
  expect(await savoirsEmpruntes(db, emprunteur)).toEqual([])
})

test('un FORK survit a la revocation et diverge librement', async () => {
  const { preteur, emprunteur } = await deuxGlobes()
  const s = await archiver(db, {
    cercle: 'globe',
    cercleId: preteur,
    sujet: 'docker',
    contenu: 'original',
  })
  await accorderEmprunt(
    db,
    { globeEmprunteurId: emprunteur, globePreteurId: preteur, savoirRacineId: s.racineId },
    'fork',
  )

  // La copie vit dans le globe emprunteur : elle est rappelee normalement.
  const rappel = await rappeler(db, { globeId: emprunteur })
  expect(rappel[0]?.contenu).toBe('original')

  // Le preteur corrige : la copie ne bouge pas. On a pris une photo.
  await corriger(db, s.racineId, 'le preteur a change d avis')
  expect((await rappeler(db, { globeId: emprunteur }))[0]?.contenu).toBe('original')

  // Et rien a revoquer : ce n'est plus emprunte, c'est possede.
  await revoquerEmprunt(db, emprunteur, s.racineId)
  expect((await rappeler(db, { globeId: emprunteur }))[0]?.contenu).toBe('original')
})

test('un globe n emprunte rien a lui-meme', async () => {
  const { preteur } = await deuxGlobes()
  const s = await archiver(db, { cercle: 'globe', cercleId: preteur, sujet: 'x', contenu: 'y' })
  await expect(
    db
      .insertInto('emprunts_savoir')
      .values({
        globe_emprunteur_id: preteur,
        globe_preteur_id: preteur,
        savoir_racine_id: s.racineId,
        mode: 'lecture',
      })
      .execute(),
  ).rejects.toThrow()
})

test('EMPRUNTER UNE FICHE CLIENT EST INEXPRIMABLE, pas refuse', async () => {
  const { preteur, emprunteur } = await deuxGlobes()
  const client = await db
    .insertInto('clients')
    .values({ name: 'Bastide', secrets: JSON.stringify({ ssh: 'SECRET' }) })
    .returning('id')
    .executeTakeFirstOrThrow()

  // La table ne reference que `savoirs`. Ni les fiches clients ni le coffre
  // n'y vivent : l'impossibilite est dans le schema, pas dans une
  // verification qu'on pourrait oublier d'ecrire.
  await expect(
    db
      .insertInto('emprunts_savoir')
      .values({
        globe_emprunteur_id: emprunteur,
        globe_preteur_id: preteur,
        savoir_racine_id: client.id,
        mode: 'lecture',
      })
      .execute(),
  ).resolves.toBeDefined()

  // La ligne existe mais ne designe AUCUN savoir : rien n'en sort, et surtout
  // aucun secret.
  const vus = await savoirsEmpruntes(db, emprunteur)
  expect(vus).toEqual([])
  expect(JSON.stringify(vus)).not.toContain('SECRET')
})

test('un meme savoir ne s emprunte qu une fois par globe', async () => {
  const { preteur, emprunteur } = await deuxGlobes()
  const s = await archiver(db, { cercle: 'globe', cercleId: preteur, sujet: 'x', contenu: 'y' })
  const d = { globeEmprunteurId: emprunteur, globePreteurId: preteur, savoirRacineId: s.racineId }
  await accorderEmprunt(db, d, 'lecture')
  await expect(accorderEmprunt(db, d, 'lecture')).rejects.toThrow()
})

test('un savoir emprunte ne prime JAMAIS sur un savoir maison du meme sujet', async () => {
  const { preteur, emprunteur } = await deuxGlobes()
  const preté = await archiver(db, {
    cercle: 'globe',
    cercleId: preteur,
    sujet: 'docker',
    contenu: 'la version du preteur',
  })
  await archiver(db, {
    cercle: 'globe',
    cercleId: emprunteur,
    sujet: 'docker',
    contenu: 'ce que NOUS avons decide',
  })
  await accorderEmprunt(
    db,
    { globeEmprunteurId: emprunteur, globePreteurId: preteur, savoirRacineId: preté.racineId },
    'lecture',
  )

  const rappel = await rappeler(db, { globeId: emprunteur })
  // On emprunte ce qu'on n'a pas, pas ce qu'on a deja decide autrement.
  expect(rappel).toHaveLength(1)
  expect(rappel[0]?.contenu).toBe('ce que NOUS avons decide')
  expect(rappel[0]?.provenance).toBe('globe')
})

test('un savoir emprunte arrive dans le rappel, etiquete comme tel', async () => {
  const { preteur, emprunteur } = await deuxGlobes()
  const s = await archiver(db, {
    cercle: 'globe',
    cercleId: preteur,
    sujet: 'docker',
    contenu: 'compose v2',
  })
  await accorderEmprunt(
    db,
    { globeEmprunteurId: emprunteur, globePreteurId: preteur, savoirRacineId: s.racineId },
    'lecture',
  )

  const rappel = await rappeler(db, { globeId: emprunteur })
  expect(rappel[0]?.contenu).toBe('compose v2')
  // L'agent doit savoir que ce savoir vient d'ailleurs.
  expect(rappel[0]?.provenance).toBe('emprunt')
})

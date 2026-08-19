import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { formaterRappel, rappeler } from '../src/knowledge/recall'
import { archiver, archiverDefinitivement, corriger, historique } from '../src/knowledge/store'
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
  await db.deleteFrom('savoirs').execute()
})

async function contexte() {
  const globe = await ensureGlobe(db)
  const client = await db
    .insertInto('clients')
    .values({ name: `Client ${randomUUID().slice(0, 6)}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const projet = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      client_id: client.id,
      name: 'Projet',
      slug: `projet-${randomUUID()}`,
      repo_full_name: 'exemple/x',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { globeId: globe.id, clientId: client.id, projetId: projet.id }
}

// --- Versionnement ---------------------------------------------------------

test('corriger cree une version, l ancienne reste lisible', async () => {
  const s = await archiver(db, {
    cercle: 'hive',
    sujet: 'version PHP',
    contenu: 'PHP 8.1 maximum.',
  })
  const v2 = await corriger(db, s.racineId, 'PHP 8.3 depuis la migration de juin.')

  expect(v2.version).toBe(2)
  const h = await historique(db, s.racineId)
  expect(h.map((x) => x.version)).toEqual([2, 1])
  // La formulation d'origine reste consultable : un savoir qui change en
  // silence est un savoir auquel on ne peut plus se fier.
  expect(h[1]?.contenu).toBe('PHP 8.1 maximum.')
})

test('une seule version active a la fois, garanti par la base', async () => {
  const s = await archiver(db, { cercle: 'hive', sujet: 'sujet', contenu: 'v1' })
  await corriger(db, s.racineId, 'v2')

  const actifs = await db
    .selectFrom('savoirs')
    .select('id')
    .where('racine_id', '=', s.racineId)
    .where('etat', '=', 'actif')
    .execute()
  expect(actifs).toHaveLength(1)

  // L'invariant est tenu par un index unique partiel, pas par du code : deux
  // ecritures concurrentes ne peuvent pas produire deux actifs.
  await expect(
    db
      .insertInto('savoirs')
      .values({ racine_id: s.racineId, cercle: 'hive', sujet: 'x', contenu: 'y' })
      .execute(),
  ).rejects.toThrow()
})

test('le compteur d utilite SURVIT a une correction', async () => {
  const ctx = await contexte()
  const s = await archiver(db, {
    cercle: 'globe',
    cercleId: ctx.globeId,
    sujet: 'convention',
    contenu: 'v1',
  })
  await rappeler(db, ctx)
  await rappeler(db, ctx)

  const v2 = await corriger(db, s.racineId, 'v2 corrigee')
  // Remettre a zero ferait remonter en tete de la revue de peremption un
  // savoir qu'on vient justement de confirmer en le corrigeant.
  expect(v2.rappels).toBe(2)
})

// --- Cascade ---------------------------------------------------------------

test('le plus specifique gagne, sujet par sujet', async () => {
  const ctx = await contexte()
  await archiver(db, { cercle: 'hive', sujet: 'version PHP', contenu: 'PHP 8.1 max.' })
  await archiver(db, {
    cercle: 'client',
    cercleId: ctx.clientId,
    sujet: 'version PHP',
    contenu: 'PHP 8.3 pour ce client.',
  })
  await archiver(db, { cercle: 'hive', sujet: 'commits', contenu: 'Messages courts.' })

  const rappel = await rappeler(db, ctx)
  const parSujet = new Map(rappel.map((s) => [s.sujet, s]))

  // Le client ecrase hive sur le meme sujet — sans que personne n'ait rien
  // supprime. C'est ce qui evite de demander a l'agent de trancher seul.
  expect(parSujet.get('version PHP')?.contenu).toBe('PHP 8.3 pour ce client.')
  expect(parSujet.get('version PHP')?.provenance).toBe('client')
  // Un sujet non couvert par un cercle plus specifique remonte quand meme.
  expect(parSujet.get('commits')?.provenance).toBe('hive')
  expect(rappel).toHaveLength(2)
})

test('un savoir de globe n atteint PAS un projet d un autre globe', async () => {
  const a = await contexte()
  await archiver(db, {
    cercle: 'globe',
    cercleId: a.globeId,
    sujet: 'secret de famille',
    contenu: 'reserve au globe A',
  })

  const autreGlobe = await db
    .insertInto('globes')
    .values({ name: 'Globe B', slug: `globe-b-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()

  const rappel = await rappeler(db, { globeId: autreGlobe.id })
  expect(rappel).toEqual([])
})

test('un cercle dont l instance est inconnue est saute, jamais devine', async () => {
  const ctx = await contexte()
  await archiver(db, {
    cercle: 'client',
    cercleId: ctx.clientId,
    sujet: 'ton',
    contenu: 'vouvoiement',
  })
  // Sans clientId, on ne pioche pas « le premier client venu ».
  const rappel = await rappeler(db, { globeId: ctx.globeId })
  expect(rappel).toEqual([])
})

test('le compteur bouge reellement a chaque rappel', async () => {
  const ctx = await contexte()
  const s = await archiver(db, { cercle: 'hive', sujet: 'x', contenu: 'y' })

  await rappeler(db, ctx)
  await rappeler(db, ctx)
  await rappeler(db, ctx)

  const ligne = await db
    .selectFrom('savoirs')
    .select('rappels')
    .where('id', '=', s.id)
    .executeTakeFirstOrThrow()
  expect(ligne.rappels).toBe(3)
})

test('un savoir archive n est plus rappele, mais son historique demeure', async () => {
  const ctx = await contexte()
  const s = await archiver(db, { cercle: 'hive', sujet: 'perime', contenu: 'obsolete' })
  await archiverDefinitivement(db, s.racineId)

  expect(await rappeler(db, ctx)).toEqual([])
  expect(await historique(db, s.racineId)).toHaveLength(1)
})

test('le format d injection annonce la provenance et interdit de recouper', async () => {
  const ctx = await contexte()
  await archiver(db, { cercle: 'hive', sujet: 'commits', contenu: 'Messages courts.' })
  const texte = formaterRappel(await rappeler(db, ctx))

  expect(texte).toContain('[hive]')
  expect(texte).toContain('Messages courts.')
  expect(texte).toContain('ne recoupe pas')
  // Rien a injecter ne doit pas produire un bloc vide dans le prompt.
  expect(formaterRappel([])).toBe('')
})

import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { formaterRappel, rappeler } from '../src/knowledge/recall'
import { archiver } from '../src/knowledge/store'
import { createProject } from '../src/projects/create'
import { ensureGlobe } from './fixtures'

/**
 * La mémoire semée est-elle RÉCOLTÉE ?
 *
 * ## Le trou
 *
 * Hive sait semer un savoir dans le cercle d'un projet depuis la création
 * conversationnelle. Rien ne le lisait. Constaté sur une vraie conversation :
 * il a rangé « ce domaine n'a pas de sitemap, les URL sont en .php, le site
 * est faiblement indexé » dans le cercle `projet`, domaine `exploitation`.
 *
 * - `recetteComplete` ne lit que le cercle `hive`
 * - `framing.ts` ne rappelait AUCUN savoir de cercle
 * - `client-kb` le verrait, mais seulement via une fiche client, et ce projet
 *   n'en avait pas
 *
 * Le savoir était en base, correctement rangé, et personne ne l'aurait lu.
 * C'est la moitié manquante de « chaque agent reçoit la mémoire dont il a
 * besoin » : le semis marchait, le dispatch n'existait pas.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
let projectId: string
let globeId: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)

  const globe = await ensureGlobe(db)
  globeId = globe.id
  const g = await db
    .selectFrom('globes')
    .select('slug')
    .where('id', '=', globe.id)
    .executeTakeFirstOrThrow()
  const projet = await createProject(db, {
    globeSlug: g.slug,
    name: 'Bastide',
    repoFullName: 'desuraweb/bastide',
  })
  projectId = projet.id

  // Le savoir réel, celui que Hive a écrit.
  await archiver(db, {
    cercle: 'projet',
    cercleId: projectId,
    domaine: 'exploitation',
    sujet: 'Inventaire des URL',
    contenu: 'Pas de sitemap · les URL actuelles sont en .php et devront être redirigées.',
  })
  await archiver(db, {
    cercle: 'projet',
    cercleId: projectId,
    domaine: 'code',
    sujet: 'Ton du contenu',
    contenu: 'Vouvoiement, registre soutenu · c’est une maison de 1880.',
  })
})

afterAll(async () => {
  await db.destroy()
})

test('le cadrage d’un dev reçoit la mémoire du projet, côté code', async () => {
  const rappel = await rappeler(db, { projetId: projectId, clientId: null, globeId }, 'code')
  expect(rappel.map((s) => s.sujet)).toEqual(['Ton du contenu'])
  expect(formaterRappel(rappel)).toContain('Vouvoiement')
})

test('et il ne reçoit PAS ce qui concerne l’exploitation', async () => {
  // Un garant n'a rien à faire d'un inventaire d'URL : ça ne l'aide pas à
  // écrire du code et ça dilue ce qui compte. Même raison que la migration
  // 0012, appliquée à la cascade des cercles.
  const rappel = await rappeler(db, { projetId: projectId, clientId: null, globeId }, 'code')
  expect(JSON.stringify(rappel)).not.toContain('.php')
})

test('le plan de déploiement reçoit l’inventaire d’URL, côté exploitation', async () => {
  const rappel = await rappeler(
    db,
    { projetId: projectId, clientId: null, globeId },
    'exploitation',
  )
  expect(rappel.map((s) => s.sujet)).toEqual(['Inventaire des URL'])
  expect(formaterRappel(rappel)).toContain('.php')
})

test('sans domaine, tout remonte · la fiche client garde ce comportement', async () => {
  // Elle montre ce qu'on SAIT d'un client, pas ce qu'un rôle doit lire.
  const rappel = await rappeler(db, { projetId: projectId, clientId: null, globeId })
  expect(rappel).toHaveLength(2)
})

test('la provenance est dite · on doit pouvoir corriger le bon savoir', async () => {
  const rappel = await rappeler(db, { projetId: projectId, clientId: null, globeId }, 'code')
  expect(rappel[0]?.provenance).toBe('projet')
  expect(formaterRappel(rappel)).toContain('[projet]')
})

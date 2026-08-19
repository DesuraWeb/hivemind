import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { rappeler } from '../src/knowledge/recall'
import { PERIODE_REVUE_JOURS, fileDeRevue, phraseHive } from '../src/knowledge/review'
import { archiver, corriger, historique } from '../src/knowledge/store'
import { ensureGlobe } from './fixtures'

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const app = await buildApp({ db })

const JOUR_MS = 86_400_000
let cookie: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await createUser(db, 'florian', 'motdepasse-de-test')
  await app.ready()
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  cookie = login.cookies.find((c) => c.name === 'hm_session')?.value as string
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

beforeEach(async () => {
  await db.deleteFrom('savoirs').execute()
})

function get(url: string) {
  return app.inject({ method: 'GET', url, cookies: { hm_session: cookie } })
}
function post(url: string) {
  return app.inject({ method: 'POST', url, cookies: { hm_session: cookie } })
}

async function contexte() {
  const globe = await ensureGlobe(db)
  const client = await db
    .insertInto('clients')
    .values({ name: `Bastide ${randomUUID().slice(0, 6)}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { globeId: globe.id, clientId: client.id }
}

/** Vieillit une racine : la revue trie par âge, et on ne peut pas attendre 90 jours. */
async function vieillir(racineId: string, jours: number) {
  // `created_at` est `Generated` : Kysely refuse de l'ecrire par le query
  // builder. Le SQL brut est la meme voie que journal-api.test.ts emprunte
  // pour vieillir une ligne.
  // En heures, pas en jours : `make_interval(days => …)` est calendaire et un
  // changement d'heure ferait tomber l'age a 199 jours pleins au lieu de 200.
  await sql`update savoirs set created_at = now() - make_interval(hours => ${jours * 24}) where racine_id = ${racineId}::uuid`.execute(
    db,
  )
}

// --- Le tri : ce que Hive met en tete ---------------------------------------

test('un savoir jamais rappele remonte en tete, devant un savoir plus ancien mais utile', async () => {
  const ctx = await contexte()
  const utile = await archiver(db, {
    cercle: 'globe',
    cercleId: ctx.globeId,
    sujet: 'matomo',
    contenu: 'Matomo auto-heberge, jamais Google Analytics.',
  })
  const jamais = await archiver(db, {
    cercle: 'globe',
    cercleId: ctx.globeId,
    sujet: 'charte',
    contenu: 'Lavande et creme.',
  })
  // Le savoir utile est LE PLUS VIEUX : sans le compteur d'utilite, c'est lui
  // qui serait en tete.
  await vieillir(utile.racineId, 300)
  await vieillir(jamais.racineId, 30)
  await rappeler(db, { globeId: ctx.globeId })
  // Le rappel a servi les deux : on remet le second a zero pour isoler le tri.
  await db.updateTable('savoirs').set({ rappels: 0 }).where('id', '=', jamais.id).execute()

  const revue = await fileDeRevue(db)
  expect(revue.items.map((i) => i.sujet)).toEqual(['charte', 'matomo'])
  expect(revue.items[0]?.pourquoi).toContain('jamais rappelé')
  expect(revue.items[0]?.rappels).toBe(0)
})

test('a utilite egale, le plus ancien passe devant', async () => {
  const vieux = await archiver(db, { cercle: 'hive', sujet: 'vieux', contenu: 'a' })
  const recent = await archiver(db, { cercle: 'hive', sujet: 'recent', contenu: 'b' })
  await vieillir(vieux.racineId, 200)
  await vieillir(recent.racineId, 5)

  const revue = await fileDeRevue(db)
  expect(revue.items.map((i) => i.sujet)).toEqual(['vieux', 'recent'])
  expect(revue.items[0]?.ageJours).toBe(200)
})

// --- Les deux gestes --------------------------------------------------------

test('garder sort le savoir de la file sans toucher au score d utilite', async () => {
  const ctx = await contexte()
  const s = await archiver(db, {
    cercle: 'client',
    cercleId: ctx.clientId,
    sujet: 'contact',
    contenu: 'Passer par Julien.',
  })
  await rappeler(db, { clientId: ctx.clientId })

  const reponse = await post(`/api/savoirs/${s.racineId}/garder`)
  expect(reponse.statusCode).toBe(200)

  const revue = await fileDeRevue(db)
  expect(revue.items).toEqual([])
  expect(revue.actifs).toBe(1)

  const ligne = await db
    .selectFrom('savoirs')
    .select(['rappels', 'etat', 'revue_at'])
    .where('racine_id', '=', s.racineId)
    .executeTakeFirstOrThrow()
  // Confirmer n'est pas rappeler : le compteur d'utilite reste la mesure du
  // rappel reel, jamais gonfle par un clic.
  expect(ligne.rappels).toBe(1)
  expect(ligne.etat).toBe('actif')
  expect(ligne.revue_at).not.toBeNull()
})

test('un savoir garde revient apres un trimestre', async () => {
  const s = await archiver(db, { cercle: 'hive', sujet: 'a garder', contenu: 'x' })
  await post(`/api/savoirs/${s.racineId}/garder`)
  expect((await fileDeRevue(db)).items).toEqual([])

  await db
    .updateTable('savoirs')
    .set({ revue_at: new Date(Date.now() - (PERIODE_REVUE_JOURS + 1) * JOUR_MS) })
    .where('racine_id', '=', s.racineId)
    .execute()

  const revue = await fileDeRevue(db)
  expect(revue.items.map((i) => i.sujet)).toEqual(['a garder'])
  expect(revue.items[0]?.pourquoi).toContain('confirmé il y a')
})

test('archiver retire du rappel sans effacer l historique', async () => {
  const ctx = await contexte()
  const s = await archiver(db, {
    cercle: 'globe',
    cercleId: ctx.globeId,
    sujet: 'o2switch',
    contenu: 'Mutualise par defaut.',
  })
  await corriger(db, s.racineId, 'Mutualise par defaut, sauf gros trafic.')

  const reponse = await post(`/api/savoirs/${s.racineId}/archiver`)
  expect(reponse.statusCode).toBe(200)

  expect(await rappeler(db, ctx)).toEqual([])
  expect((await fileDeRevue(db)).items).toEqual([])
  // Les deux versions restent lisibles : archiver n'efface rien.
  expect((await historique(db, s.racineId)).map((v) => v.version)).toEqual([2, 1])
})

test('les non traites reviennent : la file est un calcul, pas une session', async () => {
  const s1 = await archiver(db, { cercle: 'hive', sujet: 'un', contenu: 'a' })
  await archiver(db, { cercle: 'hive', sujet: 'deux', contenu: 'b' })
  await vieillir(s1.racineId, 10)

  await post(`/api/savoirs/${s1.racineId}/garder`)
  // Revue quittee ici : « deux » n'a ete ni garde ni archive.
  const revue = await fileDeRevue(db)
  expect(revue.items.map((i) => i.sujet)).toEqual(['deux'])
})

// --- La route ---------------------------------------------------------------

test('la route rend la file triee, ses compteurs et la phrase de Hive', async () => {
  const ctx = await contexte()
  const s = await archiver(db, {
    cercle: 'client',
    cercleId: ctx.clientId,
    sujet: 'charte',
    contenu: 'Lavande et creme.',
  })
  await vieillir(s.racineId, 94)

  const reponse = await get('/api/savoirs/revue')
  expect(reponse.statusCode).toBe(200)
  const body = reponse.json() as {
    periodeJours: number
    actifs: number
    aRevoir: number
    hive: string
    items: Array<{ sujet: string; cercleLabel: string; ageJours: number; pourquoi: string }>
  }
  expect(body.periodeJours).toBe(PERIODE_REVUE_JOURS)
  expect(body.actifs).toBe(1)
  expect(body.aRevoir).toBe(1)
  expect(body.items[0]?.ageJours).toBe(94)
  // Le cercle est nomme, pas rendu en uuid : « fiche client Bastide … ».
  expect(body.items[0]?.cercleLabel.startsWith('fiche client Bastide')).toBe(true)
  // La phrase de Hive parle des chiffres reels, pas d'un jugement sur le fond.
  expect(body.hive).toContain('1 savoir à revoir')
  expect(body.hive).toContain('94 jours')
})

test('un geste sur une racine inconnue est un 404, jamais un succes silencieux', async () => {
  expect((await post(`/api/savoirs/${randomUUID()}/garder`)).statusCode).toBe(404)
  expect((await post(`/api/savoirs/${randomUUID()}/archiver`)).statusCode).toBe(404)
  // Un identifiant malforme n'est pas une panne du serveur.
  expect((await post('/api/savoirs/pas-un-uuid/garder')).statusCode).toBe(400)
})

test('archiver deux fois : le second geste ne trouve plus rien a archiver', async () => {
  const s = await archiver(db, { cercle: 'hive', sujet: 'x', contenu: 'y' })
  expect((await post(`/api/savoirs/${s.racineId}/archiver`)).statusCode).toBe(200)
  expect((await post(`/api/savoirs/${s.racineId}/archiver`)).statusCode).toBe(404)
  expect((await post(`/api/savoirs/${s.racineId}/garder`)).statusCode).toBe(404)
})

// --- L'installation neuve ---------------------------------------------------

test('memoire vide : la file est vide et Hive le dit sans rien inventer', async () => {
  const revue = await fileDeRevue(db)
  expect(revue.items).toEqual([])
  expect(revue.actifs).toBe(0)
  expect(revue.aRevoir).toBe(0)
  expect(revue.hive).toContain('La mémoire est vide')
  // Aucune promesse d'echeance ni de notification : rien ne planifie
  // aujourd'hui, l'ecran ne doit pas laisser croire le contraire.
  expect(revue.hive).not.toContain('préviendra')
  expect(revue.hive).not.toContain('prochaine revue')
})

test('la phrase de Hive ne promet ni echeance ni jugement', () => {
  const phrase = phraseHive({ aRevoir: 4, actifs: 9, jamaisRappeles: 3, plusVieuxJours: 112 })
  expect(phrase).toContain('4 savoirs à revoir')
  expect(phrase).toContain('3 savoirs')
  expect(phrase).toContain('112 jours')
  // « Deux me semblent périmées » (le pack) est un jugement sur le contenu :
  // ni ce module ni un compteur ne peuvent le porter.
  expect(phrase).toContain('je ne sais pas lesquels sont faux')
  // Jamais de tiret cadratin dans une chaine d'UI.
  expect(phrase).not.toContain('—')
})

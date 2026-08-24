import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import {
  lireServeur,
  preuveHttp,
  scriptDeSonde,
  sonder,
  verdictDepuisPreuves,
} from '../src/ops/probe'
import type { OpsExecutor, PreuveSonde, SondeHttp } from '../src/ops/types'

/**
 * La sonde d'état (Phase 6, Task 1).
 *
 * Ce qui est vérifié ici n'est pas « la sonde trouve le bon état » — c'est
 * qu'elle penche du bon côté quand elle ne sait pas. L'autonomie de l'agent
 * dépend entièrement de ce verdict : se tromper vers la prudence coûte une
 * validation de plus, se tromper vers le champ libre coûte un site client.
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
  await db.deleteFrom('serveurs').execute()
})

async function creerServeur(opts: { url?: string | null } = {}): Promise<string> {
  const row = await db
    .insertInto('serveurs')
    .values({
      nom: `srv-${randomUUID().slice(0, 8)}`,
      hote: '203.0.113.10',
      utilisateur: 'silithid',
      ...(opts.url === undefined ? { url: 'https://exemple.test' } : { url: opts.url }),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

/** Un exécuteur qui rend la sortie qu'on lui dicte, sans jamais toucher un serveur. */
function executeur(stdout: string, code = 0): OpsExecutor {
  return { kind: 'faux', executer: async () => ({ code, stdout, stderr: '' }) }
}

function executeurQuiTombe(message: string): OpsExecutor {
  return {
    kind: 'faux',
    executer: async () => {
      throw new Error(message)
    },
  }
}

const SORTIE_VIDE = [
  'vhosts=0',
  'fichiers=0',
  'bases_mysql=0',
  'bases_pg=0',
  'journaux=0',
  'sonde=complete',
].join('\n')

const HTTP_RIEN: SondeHttp = async () => ({ erreur: 'connect ECONNREFUSED 203.0.113.10:443' })
const HTTP_REPOND: SondeHttp = async () => ({ statut: 200 })

// --- Le verdict, sans base ni serveur ---------------------------------------

function p(nom: string, verdict: PreuveSonde['verdict']): PreuveSonde {
  return { nom, verdict, detail: 'x' }
}

test('toutes les preuves vides, et seulement alors, donnent « vierge »', () => {
  const v = verdictDepuisPreuves([p('http', 'vide'), p('vhosts', 'vide'), p('bases', 'vide')])
  expect(v.etat).toBe('vierge')
})

test('une seule preuve occupée suffit à conclure « en service »', () => {
  const v = verdictDepuisPreuves([p('http', 'vide'), p('vhosts', 'occupe'), p('bases', 'vide')])
  expect(v.etat).toBe('en_service')
  expect(v.raison).toContain('vhosts')
})

test('une seule preuve incertaine suffit AUSSI : ne pas savoir n’est pas savoir que c’est vide', () => {
  const v = verdictDepuisPreuves([p('http', 'vide'), p('bases', 'inconnu'), p('vhosts', 'vide')])
  // C'est le cœur de la sonde. Sans cette ligne, un serveur dont MySQL refuse
  // la connexion passerait pour vierge.
  expect(v.etat).toBe('en_service')
  expect(v.raison).toMatch(/incomplète/)
})

test('aucune preuve du tout ne donne jamais le champ libre', () => {
  expect(verdictDepuisPreuves([]).etat).toBe('en_service')
})

test('un pare-feu ne se confond pas avec un serveur éteint', () => {
  // Refus explicite : rien n'écoute, c'est une preuve de vide.
  expect(preuveHttp({ erreur: 'connect ECONNREFUSED 1.2.3.4:443' }).verdict).toBe('vide')
  expect(preuveHttp({ erreur: 'getaddrinfo ENOTFOUND rien.test' }).verdict).toBe('vide')
  // Délai dépassé : un pare-feu qui nous ignore ressemble en tout point à un
  // serveur éteint, et les deux n'ont pas les mêmes conséquences.
  expect(preuveHttp({ erreur: 'timeout of 5000ms exceeded' }).verdict).toBe('inconnu')
  // Un 404 sert quand même du HTTP : quelque chose est configuré là.
  expect(preuveHttp({ statut: 404 }).verdict).toBe('occupe')
})

test('la sonde ne modifie rien : son script est en lecture seule', () => {
  const script = scriptDeSonde()
  for (const interdit of ['rm ', 'cat >', 'apt-get', 'systemctl', 'chmod', 'mkdir', '>>']) {
    expect(script.includes(interdit), interdit).toBe(false)
  }
  // Le marqueur de fin : sans lui, une connexion coupée au milieu rendrait des
  // compteurs à zéro qu'on lirait comme « vide ».
  expect(script).toContain('sonde=complete')
})

// --- La sonde réelle, en base -----------------------------------------------

test('un hôte qui sert quelque chose est « en service »', async () => {
  const id = await creerServeur()
  const r = await sonder({ db, executor: executeur(SORTIE_VIDE), http: HTTP_REPOND }, id)

  expect(r.etat).toBe('en_service')
  expect((await lireServeur(db, id)).etat).toBe('en_service')
})

test('un hôte réellement vide, mesuré de bout en bout, est « vierge »', async () => {
  const id = await creerServeur()
  const r = await sonder({ db, executor: executeur(SORTIE_VIDE), http: HTTP_RIEN }, id)

  expect(r.etat).toBe('vierge')
  const serveur = await lireServeur(db, id)
  expect(serveur.etat).toBe('vierge')
  // Le verdict est persisté AVEC ses preuves : un verdict sans preuves ne se
  // conteste pas.
  expect(serveur.preuves.length).toBe(5)
  expect(serveur.etatMesureAt).not.toBeNull()
})

test('une sonde qui échoue donne « en service », jamais « vierge »', async () => {
  const id = await creerServeur()
  const r = await sonder(
    { db, executor: executeurQuiTombe('Permission denied (publickey)'), http: HTTP_RIEN },
    id,
  )

  expect(r.etat).toBe('en_service')
  expect(r.preuves.some((preuve) => preuve.detail.includes('Permission denied'))).toBe(true)
})

test('un script interrompu au milieu ne passe pas pour un serveur vide', async () => {
  const id = await creerServeur()
  // Les compteurs sont à zéro, mais le marqueur de fin manque : la connexion a
  // été coupée. Sans ce garde-fou, ce cas donnerait exactement « vierge ».
  const tronque = 'vhosts=0\nfichiers=0\n'
  const r = await sonder({ db, executor: executeur(tronque), http: HTTP_RIEN }, id)
  expect(r.etat).toBe('en_service')
})

test('sans URL publique, le champ libre est interdit', async () => {
  const id = await creerServeur({ url: null })
  const r = await sonder({ db, executor: executeur(SORTIE_VIDE), http: HTTP_RIEN }, id)

  // Une preuve manquante est une incertitude, pas un vide.
  expect(r.etat).toBe('en_service')
  expect(r.preuves.find((preuve) => preuve.nom === 'http')?.verdict).toBe('inconnu')
})

test('ni MySQL ni PostgreSQL joignables : incertitude, pas absence de bases', async () => {
  const id = await creerServeur()
  const sansBases = [
    'vhosts=0',
    'fichiers=0',
    'bases_mysql=',
    'bases_pg=',
    'journaux=0',
    'sonde=complete',
  ].join('\n')
  const r = await sonder({ db, executor: executeur(sansBases), http: HTTP_RIEN }, id)
  expect(r.etat).toBe('en_service')
  expect(r.preuves.find((preuve) => preuve.nom === 'bases')?.verdict).toBe('inconnu')
})

// --- Le sens unique ---------------------------------------------------------

test('un serveur déjà en service le reste, même si la sonde le trouve vide', async () => {
  const id = await creerServeur()
  await sonder({ db, executor: executeur(SORTIE_VIDE), http: HTTP_REPOND }, id)
  expect((await lireServeur(db, id)).etat).toBe('en_service')

  // Le site a été retiré, tout est vide. Sans le sens unique, il suffirait de
  // vider un répertoire pour retrouver le champ libre.
  const r = await sonder({ db, executor: executeur(SORTIE_VIDE), http: HTTP_RIEN }, id)
  expect(r.etat).toBe('en_service')
  expect(r.figee).toBe(true)
  expect(r.raison).toMatch(/ne redevient jamais vierge/)
  expect((await lireServeur(db, id)).etat).toBe('en_service')
})

test('la base elle-même refuse le retour en arrière, pas seulement le code', async () => {
  const id = await creerServeur()
  await db
    .updateTable('serveurs')
    .set({ etat: 'en_service', etat_mesure_at: new Date() })
    .where('id', '=', id)
    .execute()

  // Une règle qui ne vivrait que dans du TypeScript se contournerait par un
  // `update` direct. Le trigger de la migration 0011 est le vrai garde-fou.
  await expect(
    db.updateTable('serveurs').set({ etat: 'vierge' }).where('id', '=', id).execute(),
  ).rejects.toThrow(/ne redevient jamais vierge/)
})

test('un état posé sans mesure est refusé par le schéma', async () => {
  await expect(
    db
      .insertInto('serveurs')
      .values({
        nom: `srv-${randomUUID().slice(0, 8)}`,
        hote: 'x',
        utilisateur: 'y',
        // « vierge » déclaré, jamais mesuré : exactement le geste qui
        // détruirait un site client.
        etat: 'vierge',
      })
      .execute(),
  ).rejects.toThrow(/serveurs_etat_mesure/)
})

test('un serveur neuf est « inconnu », jamais « vierge »', async () => {
  const id = await creerServeur()
  // Le défaut le plus dangereux serait « vierge » : il donnerait le champ
  // libre à la faveur d'un oubli.
  expect((await lireServeur(db, id)).etat).toBe('inconnu')
})

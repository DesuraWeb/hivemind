import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createSecretBox } from '../src/crypto/secrets'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import {
  CheminInvalideError,
  lireCible,
  listerCibles,
  poserCible,
  resoudreAcces,
  retirerCible,
} from '../src/deploy/cibles'
import { databaseUrl, loadEnv } from '../src/env'
import { createProject } from '../src/projects/create'
import { createSettingsStore } from '../src/settings/store'
import { ensureGlobe } from './fixtures'

/**
 * Où chaque projet se déploie (Lot D).
 *
 * ## Ce que ça remplace
 *
 * Le staging réel était réglé GLOBALEMENT : un hôte, un utilisateur, une
 * racine, un domaine joker, une clé de coffre — pour tous les projets. Ça ne
 * survit pas au premier client hébergé ailleurs, et la prod n'existait comme
 * cible d'aucune façon.
 *
 * Pire : `createSshGitTarget` n'était construit NULLE PART. Le staging réel
 * existait en code et rien ne l'instanciait, ce qui expliquait que le gate de
 * prod annonce toujours « aperçu local éphémère ».
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
let settings: ReturnType<typeof createSettingsStore>

let projectId: string
let serveurId: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  settings = createSettingsStore(db, await createSecretBox(env.MASTER_KEY))

  const globe = await ensureGlobe(db)
  const g = await db
    .selectFrom('globes')
    .select('slug')
    .where('id', '=', globe.id)
    .executeTakeFirstOrThrow()
  const projet = await createProject(db, {
    globeSlug: g.slug,
    name: 'Bastide',
    repoFullName: 'desura/bastide',
  })
  projectId = projet.id

  const s = await db
    .insertInto('serveurs')
    .values({
      nom: 'bastide-mutu',
      hote: 'ssh.planethoster.net',
      utilisateur: 'bastide',
      type_hebergement: 'mutualise',
      hebergeur: 'planethoster',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  serveurId = s.id
})

afterAll(async () => {
  await db.destroy()
})

test('un projet peut avoir un staging ET une prod, chacun ailleurs', async () => {
  await poserCible(db, {
    projectId,
    cible: 'staging',
    serveurId,
    chemin: '/home/bastide/stg',
    domaine: 'stg.bastide.fr',
  })
  await poserCible(db, {
    projectId,
    cible: 'prod',
    serveurId,
    chemin: '/home/bastide/public_html',
    domaine: 'bastide.fr',
  })

  const cibles = await listerCibles(db, projectId)
  expect(cibles.map((c) => c.cible)).toEqual(['prod', 'staging'])
  // Le serveur fait foi pour l'hôte : rien n'est recopié, donc rien ne peut
  // diverger au premier changement d'IP.
  expect(cibles[0]?.hote).toBe('ssh.planethoster.net')
  expect(cibles[0]?.typeHebergement).toBe('mutualise')
})

test('le staging SURVIT à la prod', async () => {
  // C'est ce qui permet de ne pas prendre de risque : on pousse sur le
  // staging, le juge y passe, et la promotion est un second geste sur du code
  // déjà vu tourner.
  const staging = await lireCible(db, projectId, 'staging')
  expect(staging?.domaine).toBe('stg.bastide.fr')
})

test('reposer une cible la remplace, elle ne la duplique pas', async () => {
  await poserCible(db, {
    projectId,
    cible: 'staging',
    serveurId,
    chemin: '/home/bastide/recette',
    domaine: 'recette.bastide.fr',
  })
  const cibles = await listerCibles(db, projectId)
  // Deux `staging` sur le même projet rendraient le déploiement non
  // déterministe : l'unicité est au schéma, pas dans le code appelant.
  expect(cibles.filter((c) => c.cible === 'staging')).toHaveLength(1)
  expect((await lireCible(db, projectId, 'staging'))?.chemin).toBe('/home/bastide/recette')
})

test('un chemin relatif ou remontant est refusé', async () => {
  // Même validation que dans un plan d'exploitation. Un chemin relatif se
  // résoudrait depuis le répertoire de connexion SSH, qui n'est pas le même
  // selon le compte ; une remontée écrirait hors du répertoire du projet.
  for (const chemin of ['home/bastide', '/home/bastide/../../etc', '../public_html']) {
    await expect(
      poserCible(db, { projectId, cible: 'prod', serveurId, chemin }),
      chemin,
    ).rejects.toThrow(CheminInvalideError)
  }
})

test('une cible absente n’est pas une panne', async () => {
  const autre = await createProject(db, {
    globeSlug: (await db.selectFrom('globes').select('slug').executeTakeFirstOrThrow()).slug,
    name: 'Sans cible',
    repoFullName: 'desura/sans-cible',
  })
  // Un projet dont personne n'a dit où il allait retombe sur l'aperçu local.
  expect(await resoudreAcces(db, settings, autre.id, 'staging')).toBeNull()
})

test('une cible SANS sa clé lève, au lieu de retomber en silence', async () => {
  // La distinction qui compte : « pas de cible » et « cible à moitié
  // configurée » ne mènent pas au même comportement. Confondre les deux ferait
  // juger un aperçu local éphémère en croyant juger un staging.
  await expect(resoudreAcces(db, settings, projectId, 'staging')).rejects.toThrow(/bastide-mutu/)
})

test('la clé du coffre est celle du SERVEUR, pas une clé de déploiement unique', async () => {
  await settings.setSecret('ops.bastide-mutu.ssh_private_key', 'UNE-CLE-DE-TEST')
  const acces = await resoudreAcces(db, settings, projectId, 'staging')
  expect(acces?.clePrivee).toBe('UNE-CLE-DE-TEST')
  // Un jeu par machine : une clé compromise n'ouvre pas le parc.
  expect(acces?.serveurNom).toBe('bastide-mutu')
})

test('supprimer un serveur qui sert échoue bruyamment', async () => {
  // `restrict` et non `cascade` : effacer la configuration de déploiement d'un
  // projet vivant parce qu'on a supprimé un serveur serait une perte de
  // données déguisée en nettoyage.
  await expect(db.deleteFrom('serveurs').where('id', '=', serveurId).execute()).rejects.toThrow()
})

test('retirer une cible ne touche pas à l’autre', async () => {
  await retirerCible(db, projectId, 'prod')
  expect(await lireCible(db, projectId, 'prod')).toBeNull()
  expect(await lireCible(db, projectId, 'staging')).not.toBeNull()
})

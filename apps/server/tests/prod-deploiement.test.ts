import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createSecretBox } from '../src/crypto/secrets'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { poserCible } from '../src/deploy/cibles'
import { type ResultatProd, deployerEnProd } from '../src/deploy/prod'
import { construireScriptDeploiement } from '../src/deploy/ssh-git'
import { databaseUrl, loadEnv } from '../src/env'
import type { OpsExecutor } from '../src/ops/types'
import { createProject } from '../src/projects/create'
import { createSettingsStore } from '../src/settings/store'
import { ensureGlobe } from './fixtures'

/**
 * La mise en production (Lot E).
 *
 * ## Ce que ce fichier garde
 *
 * Le code le plus dangereux du produit : un agent qui écrit sur un site client
 * vivant, et qui touche à une base. Les propriétés gardées ici ne sont pas des
 * détails d'implémentation, ce sont les seules choses qui rendent ce geste
 * acceptable.
 *
 * 1. On REFUSE de migrer sans commande de sauvegarde.
 * 2. On VÉRIFIE la sauvegarde. Pas « la commande a rendu 0 » : le fichier doit
 *    exister et ne pas être vide. Une commande qui rend 0 en écrivant zéro
 *    octet existe, et c'est exactement le cas qui ferait migrer sans filet.
 * 3. Une migration qui échoue déclenche la restauration TOUT DE SUITE, sans
 *    attendre une décision humaine.
 * 4. Rien ne part avant que la sauvegarde ne soit vérifiée.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
let settings: ReturnType<typeof createSettingsStore>
let projectId: string
let serveurId: string

/** Un exécuteur scripté : on décide du code de retour par motif de commande. */
function executeur(reponses: Array<{ motif: RegExp; code: number; stderr?: string }>) {
  const vues: string[] = []
  const executor: OpsExecutor = {
    kind: 'faux',
    async executer(_serveur, commande) {
      vues.push(commande)
      const r = reponses.find((x) => x.motif.test(commande))
      return { code: r?.code ?? 0, stdout: '', stderr: r?.stderr ?? '' }
    },
  }
  return { executor, vues }
}

const httpVivant = async () => ({ statut: 200 })
const poseOk = async () => ({ ok: true, detail: 'code poussé' })

async function lancer(
  opts: {
    migrations?: string[]
    reponses?: Array<{ motif: RegExp; code: number; stderr?: string }>
    pose?: () => Promise<{ ok: boolean; detail: string }>
    http?: typeof httpVivant
  } = {},
): Promise<{ res: ResultatProd; vues: string[] }> {
  const { executor, vues } = executeur(opts.reponses ?? [])
  const res = await deployerEnProd(
    {
      db,
      settings,
      executor,
      http: (opts.http ?? httpVivant) as never,
      poserLeCode: opts.pose ?? poseOk,
    },
    {
      projectId,
      migrations: opts.migrations ?? [],
      horodatage: '20260826T090000',
      runId: null,
      projectSlug: 'bastide',
    },
  )
  return { res, vues }
}

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
    .values({ nom: 'bastide', hote: 'h', utilisateur: 'u', type_hebergement: 'mutualise' })
    .returning('id')
    .executeTakeFirstOrThrow()
  serveurId = s.id
  await settings.setSecret('ops.bastide.ssh_private_key', 'CLE')
})

afterAll(async () => {
  await db.destroy()
})

test('sans cible de production, rien n’est tenté', async () => {
  const { res, vues } = await lancer()
  expect(res.ok).toBe(false)
  expect(res.raison).toContain('aucune cible de production')
  // Pas une seule commande n'a été envoyée sur la machine.
  expect(vues).toEqual([])
})

test('un déploiement sans migration ne touche pas à la base', async () => {
  await poserCible(db, {
    projectId,
    cible: 'prod',
    serveurId,
    chemin: '/home/bastide/public_html',
    domaine: 'bastide.fr',
  })

  const { res, vues } = await lancer()
  expect(res.ok).toBe(true)
  expect(res.etapes.map((e) => e.nom)).toEqual(['deploiement', 'sonde'])
  // Aucune sauvegarde, aucune migration : un projet sans base ne paie pas pour
  // une machinerie dont il n'a pas besoin.
  expect(vues).toEqual([])
})

test('des migrations sans commande de sauvegarde · REFUS', async () => {
  const { res, vues } = await lancer({ migrations: ['db/0007.sql'] })
  expect(res.ok).toBe(false)
  expect(res.raison).toContain('on ne migre pas sans filet')
  // Le refus a lieu AVANT tout : rien n'a été déployé non plus.
  expect(vues).toEqual([])
  expect(res.etapes).toEqual([])
})

test('une sauvegarde vide arrête tout, même si la commande a rendu 0', async () => {
  await poserCible(db, {
    projectId,
    cible: 'prod',
    serveurId,
    chemin: '/home/bastide/public_html',
    domaine: 'bastide.fr',
    commandeSauvegarde: 'mysqldump base > {{fichier}}',
    commandeMigration: 'php bin/console migrate',
    commandeRestauration: 'mysql base < {{fichier}}',
  })

  // Le cas exact qu'on cherche : la commande réussit, le fichier est vide.
  const { res, vues } = await lancer({
    migrations: ['db/0007.sql'],
    reponses: [{ motif: /^test -s/, code: 1 }],
  })

  expect(res.ok).toBe(false)
  expect(res.raison).toContain('vide ou absente')
  expect(res.etapes.map((e) => e.nom)).toEqual(['sauvegarde', 'verification_sauvegarde'])
  // Rien n'est parti : ni code, ni migration.
  expect(vues.some((v) => v.includes('migrate'))).toBe(false)
})

test('la sauvegarde vient AVANT le code, et le code avant la migration', async () => {
  const { res, vues } = await lancer({ migrations: ['db/0007.sql'] })
  expect(res.ok).toBe(true)
  expect(res.etapes.map((e) => e.nom)).toEqual([
    'sauvegarde',
    'verification_sauvegarde',
    'deploiement',
    'migration',
    'sonde',
  ])
  // Le dump doit exister avant que quoi que ce soit ne bouge, et le code neuf
  // doit être en place quand ses migrations tournent.
  expect(vues[0]).toContain('mysqldump')
  expect(vues[1]).toContain('test -s')
  expect(vues[2]).toContain('migrate')
})

test('une migration qui échoue restaure SANS attendre personne', async () => {
  const { res, vues } = await lancer({
    migrations: ['db/0007.sql'],
    reponses: [{ motif: /migrate/, code: 1, stderr: 'colonne inconnue' }],
  })

  expect(res.ok).toBe(false)
  expect(res.restaure).toBe(true)
  expect(res.raison).toContain('base restaurée')
  expect(res.etapes.map((e) => e.nom)).toContain('restauration')
  // Restauré depuis le dump VÉRIFIÉ, pas depuis un fichier supposé.
  expect(vues.at(-1)).toContain('mysql base < /home/bastide/public_html/.silithid-sauvegarde-')
})

test('migration ET restauration échouées · on le dit sans l’arrondir', async () => {
  const { res } = await lancer({
    migrations: ['db/0007.sql'],
    reponses: [
      { motif: /migrate/, code: 1 },
      { motif: /mysql base </, code: 1 },
    ],
  })
  expect(res.ok).toBe(false)
  expect(res.restaure).toBe(false)
  expect(res.raison).toContain('intervention manuelle immédiate')
})

test('un site qui ne répond plus après déploiement est un échec', async () => {
  // « Déployé » ne doit pas vouloir dire « la commande n'a pas rendu
  // d'erreur ». Sans cette sonde, on l'apprendrait par un client.
  const { res } = await lancer({ http: (async () => ({ statut: 502 })) as never })
  expect(res.ok).toBe(false)
  expect(res.raison).toContain('ne répond pas')
  expect(res.etapes.at(-1)?.nom).toBe('sonde')
  expect(res.url).toBe('https://bastide.fr')
})

test('un déploiement qui échoue ne migre jamais', async () => {
  const { res, vues } = await lancer({
    migrations: ['db/0007.sql'],
    pose: async () => ({ ok: false, detail: 'git push refusé' }),
  })
  expect(res.ok).toBe(false)
  expect(res.raison).toContain('git push refusé')
  expect(vues.some((v) => v.includes('migrate'))).toBe(false)
})

test('une PRODUCTION ne reçoit jamais le robots.txt du staging', () => {
  // Le défaut le plus lourd trouvé dans ce lot. Le script posait `Disallow: /`
  // à CHAQUE déploiement — juste pour un staging, catastrophique sur une prod
  // client : le site sort de l'index.
  //
  // Casser une URL indexée est la faute la plus chère du métier ; les
  // désindexer toutes d'un coup en est la version maximale, et elle serait
  // notre fait.
  const script = construireScriptDeploiement({
    dir: '/home/bastide/public_html',
    repoUrl: 'https://github.com/desura/bastide.git',
    branch: 'main',
    bloquerLesRobots: false,
  })
  expect(script).not.toContain('robots.txt')
  // Le reste du déploiement est identique : c'est la SEULE différence.
  expect(script).toContain('git reset --hard FETCH_HEAD')
})

test('un STAGING le reçoit toujours · l’oubli exposerait le site dupliqué d’un client', () => {
  const script = construireScriptDeploiement({
    dir: '/srv/staging/bastide',
    repoUrl: 'https://github.com/desura/bastide.git',
    branch: 'silithid/step-1',
    bloquerLesRobots: true,
  })
  expect(script).toContain('robots.txt')
  expect(script).toContain('Disallow')
  // Posé APRÈS le clean, sinon il serait balayé par celui-ci.
  expect(script.indexOf('robots.txt')).toBeGreaterThan(script.indexOf('git clean'))
})

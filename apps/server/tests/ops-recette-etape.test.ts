import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { type InboxItemRow, listInbox } from '../src/inbox/repo'
import {
  EtapeHorsCatalogueError,
  ajouterEtapeApprouvee,
  proposerEtapes,
} from '../src/ops/recipe-proposal'
import {
  RECETTES_GENERIQUES,
  STACK_RECIPES_SETTINGS_KEY,
  recettePourStack,
} from '../src/ops/recipes'

/**
 * L'ajout d'une ÉTAPE à une recette (Phase 6, Task 7 · la moitié qui ne
 * s'accumule pas toute seule).
 *
 * Un rappel est du texte : il informe. Une étape s'EXÉCUTE, en champ libre,
 * sur le prochain serveur vierge de la stack. Une étape qui s'ajouterait
 * d'elle-même serait du pouvoir qui s'élargit sans décision humaine — la ligne
 * de toute la phase.
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
  await db.deleteFrom('settings').execute()
  await db
    .insertInto('settings')
    .values({ key: STACK_RECIPES_SETTINGS_KEY, value: JSON.stringify(RECETTES_GENERIQUES) })
    .execute()
})

const POURQUOI = 'Toutes les boutiques de cette stack en ont besoin, pas seulement ce serveur-ci.'

async function resoudre(
  item: InboxItemRow,
  reponse: Record<string, unknown>,
): Promise<InboxItemRow> {
  await db
    .updateTable('inbox_items')
    .set({ status: 'done', human_response: JSON.stringify(reponse), resolved_at: new Date() })
    .where('id', '=', item.id)
    .execute()
  return (await listInbox(db, {})).find((i) => i.id === item.id) as InboxItemRow
}

test('une étape proposée montre la commande qu’elle exécutera', async () => {
  const items = await proposerEtapes({ db, stack: 'prestashop' }, [
    { nom: 'poser_cron', pourquoi: POURQUOI },
  ])

  expect(items).toHaveLength(1)
  expect(items[0]?.subtype).toBe('recette')
  expect(items[0]?.fromRole).toBe('ops')
  // Approuver sans voir ce que ça exécutera reviendrait à signer un chèque en
  // blanc pour tous les déploiements PrestaShop à venir.
  expect(items[0]?.payload.commande).toContain('/etc/cron.d/')
  expect(items[0]?.payload.ctx).toMatch(/sans validation.*VIERGE/)
})

test('une étape déjà dans la recette n’est pas reproposée', async () => {
  // `installer_paquet` est déjà dans la recette PrestaShop livrée au seed.
  const items = await proposerEtapes({ db, stack: 'prestashop' }, [
    { nom: 'installer_paquet', pourquoi: POURQUOI },
  ])
  expect(items).toHaveLength(0)
})

test('une proposition ouverte en bloque un doublon', async () => {
  await proposerEtapes({ db, stack: 'astro' }, [{ nom: 'poser_cron', pourquoi: POURQUOI }])
  // Sans ce garde-fou, l'inbox se remplirait à chaque déploiement de la stack.
  const second = await proposerEtapes({ db, stack: 'astro' }, [
    { nom: 'poser_cron', pourquoi: POURQUOI },
  ])
  expect(second).toHaveLength(0)
  expect(await listInbox(db, { status: 'open' })).toHaveLength(1)
})

test('une opération hors catalogue est refusée à la PROPOSITION', async () => {
  await expect(
    proposerEtapes({ db, stack: 'astro' }, [
      { nom: 'executer_commande' as never, pourquoi: POURQUOI },
    ]),
  ).rejects.toThrow(EtapeHorsCatalogueError)
  expect(await listInbox(db, {})).toHaveLength(0)
})

test('une opération hors catalogue est refusée À L’ÉCRITURE aussi', async () => {
  const [item] = await proposerEtapes({ db, stack: 'astro' }, [
    { nom: 'poser_cron', pourquoi: POURQUOI },
  ])

  // Item forgé en base entre la proposition et la validation : deux garde-fous
  // valent mieux qu'un, chacun ferme une porte que l'autre laisse ouverte.
  const payload = { ...(item as InboxItemRow).payload }
  payload.etape = { stack: 'astro', nom: 'rm_rf', pourquoi: POURQUOI }
  await db
    .updateTable('inbox_items')
    .set({ payload: JSON.stringify(payload) })
    .where('id', '=', (item as InboxItemRow).id)
    .execute()

  const relu = await resoudre(item as InboxItemRow, { approved: true })
  await expect(ajouterEtapeApprouvee(db, relu)).rejects.toThrow(EtapeHorsCatalogueError)
  // La recette n'a pas bougé.
  expect((await recettePourStack(db, 'astro'))?.recette.etapes).toHaveLength(2)
})

test('approuver ajoute l’étape à la recette de CETTE stack seulement', async () => {
  const [item] = await proposerEtapes({ db, stack: 'astro' }, [
    { nom: 'poser_cron', pourquoi: POURQUOI },
  ])
  const relu = await resoudre(item as InboxItemRow, { approved: true })

  const ajoutee = await ajouterEtapeApprouvee(db, relu)
  expect(ajoutee?.operation).toBe('poser_cron')

  const astro = await recettePourStack(db, 'astro')
  expect(astro?.recette.etapes.map((e) => e.operation)).toContain('poser_cron')
  // Une stack n'hérite jamais de ce qu'une autre a appris.
  const presta = await recettePourStack(db, 'prestashop')
  expect(presta?.recette.etapes.map((e) => e.operation)).not.toContain('poser_cron')
})

test('la formulation de Florian écrase celle de l’agent', async () => {
  const [item] = await proposerEtapes({ db, stack: 'astro' }, [
    { nom: 'poser_cron', pourquoi: POURQUOI },
  ])
  const relu = await resoudre(item as InboxItemRow, {
    approved: true,
    text: 'Purge du cache toutes les nuits · sinon le disque sature en trois semaines.',
  })
  await ajouterEtapeApprouvee(db, relu)

  const astro = await recettePourStack(db, 'astro')
  const posee = astro?.recette.etapes.find((e) => e.operation === 'poser_cron')
  expect(posee?.pourquoi).toContain('le disque sature')
  expect(posee?.pourquoi).not.toBe(POURQUOI)
})

test('refuser ne change rien à la recette', async () => {
  const [item] = await proposerEtapes({ db, stack: 'astro' }, [
    { nom: 'poser_cron', pourquoi: POURQUOI },
  ])
  const relu = await resoudre(item as InboxItemRow, { approved: false })

  expect(await ajouterEtapeApprouvee(db, relu)).toBeNull()
  expect((await recettePourStack(db, 'astro'))?.recette.etapes).toHaveLength(2)
})

test('une étape approuvée deux fois ne se duplique pas', async () => {
  const [item] = await proposerEtapes({ db, stack: 'astro' }, [
    { nom: 'poser_cron', pourquoi: POURQUOI },
  ])
  const relu = await resoudre(item as InboxItemRow, { approved: true })

  await ajouterEtapeApprouvee(db, relu)
  // Un rejeu (retry HTTP, double clic) ne doit pas poser l'étape deux fois.
  expect(await ajouterEtapeApprouvee(db, relu)).toBeNull()
  expect(
    (await recettePourStack(db, 'astro'))?.recette.etapes.filter(
      (e) => e.operation === 'poser_cron',
    ),
  ).toHaveLength(1)
})

test('une stack sans recette en reçoit une, plutôt que de perdre l’étape', async () => {
  const [item] = await proposerEtapes({ db, stack: 'phoenix' }, [
    { nom: 'installer_paquet', pourquoi: POURQUOI },
  ])
  const relu = await resoudre(item as InboxItemRow, { approved: true })
  await ajouterEtapeApprouvee(db, relu)

  const phoenix = await recettePourStack(db, 'Elixir Phoenix')
  expect(phoenix?.recette.etapes).toHaveLength(1)
  expect(phoenix?.recette.resume).toContain('déploiements')
})

test('un item d’un autre type ne touche jamais la recette', async () => {
  const bidon = {
    id: randomUUID(),
    type: 'approval',
    subtype: 'prod',
    projectId: null,
    runId: null,
    title: 'x',
    fromRole: 'garant',
    payload: { etape: { stack: 'astro', nom: 'poser_cron' } },
    status: 'done',
    humanResponse: { approved: true },
    createdAt: new Date(),
    blockedSince: new Date(),
    resolvedAt: new Date(),
    archiveToClient: false,
  } as InboxItemRow

  expect(await ajouterEtapeApprouvee(db, bidon)).toBeNull()
  expect((await recettePourStack(db, 'astro'))?.recette.etapes).toHaveLength(2)
})

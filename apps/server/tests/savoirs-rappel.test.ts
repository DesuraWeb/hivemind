import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { listInbox } from '../src/inbox/repo'
import { resolveInboxItem } from '../src/inbox/resolve'
import { createBoss } from '../src/jobs/boss'
import {
  PLANCHER_RAPPEL_JOURS,
  REVUE_INBOX_SUBTYPE,
  deciderRappelRevue,
  rappelerRevue,
} from '../src/knowledge/revue-notif'
import { archiver } from '../src/knowledge/store'
import { ensureGlobe } from './fixtures'
import { stopBoss } from './stop-boss'

/**
 * La revue des savoirs prévient enfin.
 *
 * `review.ts` disait honnêtement « il ne planifie rien et ne prévient
 * personne » : l'écran existait, la file se calculait, et personne ne savait
 * jamais qu'il fallait y aller. Ce fichier vérifie surtout l'inverse du
 * problème — qu'on ne HARCÈLE pas. Un rappel qui revient tous les jours
 * apprend à ignorer l'inbox, et vaut alors moins que pas de rappel du tout.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const boss = createBoss(env)

const JOUR_MS = 86_400_000

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await boss.start()
})

afterAll(async () => {
  await stopBoss(boss)
  await db.destroy()
})

beforeEach(async () => {
  await db.deleteFrom('savoirs').execute()
  await db.deleteFrom('inbox_items').execute()
})

async function savoirPerime(sujet: string, jours = 200): Promise<void> {
  const globe = await ensureGlobe(db)
  const savoir = await archiver(db, {
    cercle: 'globe',
    cercleId: globe.id,
    sujet,
    contenu: `Contenu de ${sujet}, archivé il y a longtemps.`,
  })
  await sql`update savoirs set created_at = now() - make_interval(hours => ${jours * 24}) where racine_id = ${savoir.racineId}::uuid`.execute(
    db,
  )
}

/** Vieillit le dernier rappel levé, pour éprouver le plancher d'un mois. */
async function vieillirRappel(itemId: string, jours: number): Promise<void> {
  await sql`update inbox_items set created_at = now() - make_interval(hours => ${jours * 24}) where id = ${itemId}::uuid`.execute(
    db,
  )
}

// --- La décision, sans base et sans horloge ---------------------------------

const MAINTENANT = new Date('2026-08-21T08:00:00Z')

test('rien à revoir, rien à dire', () => {
  const d = deciderRappelRevue({ aRevoir: 0, rappelOuvert: false, dernier: null }, MAINTENANT)
  expect(d.lever).toBe(false)
  expect(d.raison).toMatch(/rien à revoir/)
})

test('un rappel déjà ouvert en interdit un second', () => {
  const d = deciderRappelRevue(
    { aRevoir: 12, rappelOuvert: true, dernier: { aRevoir: 12, leveA: MAINTENANT } },
    MAINTENANT,
  )
  expect(d.lever).toBe(false)
})

test('résolu hier, file stable : on se tait', () => {
  const hier = new Date(MAINTENANT.getTime() - JOUR_MS)
  const d = deciderRappelRevue(
    { aRevoir: 12, rappelOuvert: false, dernier: { aRevoir: 12, leveA: hier } },
    MAINTENANT,
  )
  // Le cas qui fait tout l'intérêt de la fonction : il RESTE des savoirs à
  // revoir, et se taire est quand même la bonne réponse.
  expect(d.lever).toBe(false)
  expect(d.raison).toMatch(/récent/)
})

test('la file qui grandit rouvre la bouche tout de suite', () => {
  const hier = new Date(MAINTENANT.getTime() - JOUR_MS)
  const d = deciderRappelRevue(
    { aRevoir: 13, rappelOuvert: false, dernier: { aRevoir: 12, leveA: hier } },
    MAINTENANT,
  )
  expect(d.lever).toBe(true)
  expect(d.raison).toMatch(/12 → 13/)
})

test('le plancher d’un mois rattrape un rappel fermé sans revue', () => {
  const vieux = new Date(MAINTENANT.getTime() - PLANCHER_RAPPEL_JOURS * JOUR_MS)
  const d = deciderRappelRevue(
    { aRevoir: 12, rappelOuvert: false, dernier: { aRevoir: 12, leveA: vieux } },
    MAINTENANT,
  )
  // Sans ce plancher, fermer le rappel sans faire la revue le ferait
  // disparaître pour toujours : la file ne grandirait plus si rien ne vieillit.
  expect(d.lever).toBe(true)
  expect(d.raison).toMatch(/30 j/)

  const veille = new Date(MAINTENANT.getTime() - (PLANCHER_RAPPEL_JOURS - 1) * JOUR_MS)
  expect(
    deciderRappelRevue(
      { aRevoir: 12, rappelOuvert: false, dernier: { aRevoir: 12, leveA: veille } },
      MAINTENANT,
    ).lever,
  ).toBe(false)
})

// --- Le rappel réel, en base ------------------------------------------------

test('une mémoire vide ne lève aucun rappel', async () => {
  const r = await rappelerRevue(db)
  expect(r.leve).toBe(false)
  expect(r.aRevoir).toBe(0)
  expect(await listInbox(db, { type: 'info' })).toHaveLength(0)
})

test('un savoir jamais confirmé depuis un trimestre lève un rappel lisible', async () => {
  await savoirPerime('matomo')

  const r = await rappelerRevue(db)
  expect(r.leve).toBe(true)
  expect(r.aRevoir).toBe(1)

  const items = await listInbox(db, { type: 'info' })
  expect(items).toHaveLength(1)
  const item = items[0]
  expect(item?.subtype).toBe(REVUE_INBOX_SUBTYPE)
  expect(item?.title).toContain('1 à revoir')
  // Personne n'a rédigé ce rappel, il est calculé : lui coller un nom d'agent
  // laisserait croire qu'un rôle a jugé la mémoire.
  expect(item?.fromRole).toBe('system')
  // La phrase est celle de l'écran de revue, mot pour mot — jamais une version
  // plus alarmante pour faire cliquer.
  expect(typeof item?.payload.hive).toBe('string')
  expect(item?.payload.aRevoir).toBe(1)
})

test('deux passages consécutifs ne lèvent qu’un seul rappel', async () => {
  await savoirPerime('matomo')

  expect((await rappelerRevue(db)).leve).toBe(true)
  const second = await rappelerRevue(db)
  expect(second.leve).toBe(false)
  expect(second.raison).toMatch(/déjà ouvert/)
  expect(await listInbox(db, { type: 'info' })).toHaveLength(1)
})

test('résoudre le rappel ne le fait pas revenir dès le lendemain', async () => {
  await savoirPerime('matomo')
  const premier = await rappelerRevue(db)
  await resolveInboxItem(db, boss, premier.itemId as string, { action: 'vu' })

  // Le savoir est toujours à revoir : le rappel a été fermé, pas la revue faite.
  const apres = await rappelerRevue(db)
  expect(apres.aRevoir).toBe(1)
  expect(apres.leve).toBe(false)
  expect(await listInbox(db, { type: 'info' })).toHaveLength(1)
})

test('un savoir de plus après résolution relance le rappel', async () => {
  await savoirPerime('matomo')
  const premier = await rappelerRevue(db)
  await resolveInboxItem(db, boss, premier.itemId as string, { action: 'vu' })

  await savoirPerime('charte')
  const apres = await rappelerRevue(db)
  expect(apres.leve).toBe(true)
  expect(apres.aRevoir).toBe(2)
  expect(await listInbox(db, { type: 'info' })).toHaveLength(2)
})

test('au bout d’un mois le rappel revient même sans rien de nouveau', async () => {
  await savoirPerime('matomo')
  const premier = await rappelerRevue(db)
  await resolveInboxItem(db, boss, premier.itemId as string, { action: 'vu' })
  await vieillirRappel(premier.itemId as string, PLANCHER_RAPPEL_JOURS + 1)

  const apres = await rappelerRevue(db)
  expect(apres.leve).toBe(true)
  expect(apres.raison).toMatch(/dernier rappel/)
})

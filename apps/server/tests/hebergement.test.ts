import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { validerPlan } from '../src/ops/apply'
import { NOMS_OPERATIONS, estPossibleSur, operationsAutorisees } from '../src/ops/operations'
import { opsPlanSchemaPour } from '../src/ops/plan'

/**
 * Le type d'hébergement décide de ce qui EXISTE (Lot B).
 *
 * ## Le problème
 *
 * Quatre des six opérations sont impossibles sur du mutualisé : pas d'apt,
 * pas de systemctl, les extensions PHP dans un panneau, les crons aussi le
 * plus souvent. Le catalogue les proposait quand même.
 *
 * `sudo` (migration 0013) ne le disait pas : il modélise « on préfixe la
 * commande ou pas », pas « le geste est possible ». Les deux ne se déduisent
 * pas l'un de l'autre.
 *
 * ## Ce que ce fichier garde
 *
 * Que le filtrage soit vrai des DEUX côtés : ce qu'on propose au modèle, et ce
 * qu'on accepte de lui. Le premier évite un aller-retour de validation pour
 * rien ; le second est le rempart quand un plan vient d'ailleurs — d'une
 * recette, d'un réglage édité à la main, ou d'un chemin qu'on ajoutera demain.
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

test('un mutualisé ne peut que poser des fichiers et les relire', () => {
  expect([...operationsAutorisees('mutualise')].sort()).toEqual(['ecrire_fichier', 'lire_fichier'])
  // Un VPS garde tout : c'est le comportement d'avant, et il ne doit pas
  // changer parce qu'un second type d'hébergement est apparu.
  expect(operationsAutorisees('vps')).toEqual(NOMS_OPERATIONS)
})

test('les quatre gestes privilégiés sont refusés sur un mutualisé', () => {
  for (const nom of [
    'installer_paquet',
    'activer_extension_php',
    'recharger_service',
    'poser_cron',
  ]) {
    expect(estPossibleSur(nom, 'mutualise'), nom).toBe(false)
    expect(estPossibleSur(nom, 'vps'), nom).toBe(true)
  }
})

test('le modèle ne VOIT pas ce qu’il ne peut pas faire', () => {
  // Le point du lot. Un agent à qui on demande dans son prompt de ne pas
  // proposer `installer_paquet` le proposera un jour. Une opération absente
  // de l'énumération qu'on lui donne, jamais.
  const schema = opsPlanSchemaPour('mutualise')
  const refus = schema.safeParse({
    constate: ['php 7.4 en place'],
    suppose: [],
    operations: [
      {
        nom: 'installer_paquet',
        params: { paquet: 'nginx' },
        raison: 'Il faut un serveur web pour servir les fichiers du site.',
        si_rien_ne_change: 'rien ne répond',
      },
    ],
  })
  expect(refus.success).toBe(false)

  const accepte = opsPlanSchemaPour('mutualise').safeParse({
    constate: ['document root dans public_html'],
    suppose: [],
    operations: [
      {
        nom: 'ecrire_fichier',
        params: { chemin: '/home/u/public_html/robots.txt', contenu: 'User-agent: *' },
        raison: 'Le SEO de base n’est jamais optionnel sur un site public.',
        si_rien_ne_change: 'les robots indexent ce qu’ils veulent',
      },
    ],
  })
  expect(accepte.success).toBe(true)
})

test('un VPS accepte toujours les six', () => {
  const ok = opsPlanSchemaPour('vps').safeParse({
    constate: ['machine vierge'],
    suppose: [],
    operations: [
      {
        nom: 'installer_paquet',
        params: { paquet: 'nginx' },
        raison: 'Il faut un serveur web pour servir les fichiers du site.',
        si_rien_ne_change: 'rien ne répond',
      },
    ],
  })
  expect(ok.success).toBe(true)
})

test('la validation refuse à l’arrivée, et dit la VRAIE raison', () => {
  // Défense en profondeur : le schéma ne suffit pas, un plan peut venir d'une
  // recette ou d'un réglage édité à la main.
  const v = validerPlan([{ nom: 'installer_paquet', params: { paquet: 'nginx' } }], 'mutualise')
  expect(v.ok).toBe(false)
  if (v.ok) return
  // « n'existe pas sur un hébergement mutualise », PAS « opération inconnue ».
  // Confondre les deux enverrait chercher un bug dans le catalogue au lieu de
  // regarder le serveur.
  expect(v.raison).toContain('mutualise')
  expect(v.raison).not.toContain('inconnue')
})

test('sans type déclaré, la validation se comporte comme avant', () => {
  const v = validerPlan([{ nom: 'installer_paquet', params: { paquet: 'nginx' } }])
  expect(v.ok).toBe(true)
})

test('un serveur créé sans type est un VPS, et rien ne change pour lui', async () => {
  const row = await db
    .insertInto('serveurs')
    .values({ nom: 'ancien', hote: 'h', utilisateur: 'u' })
    .returning(['type_hebergement', 'hebergeur', 'client_id'])
    .executeTakeFirstOrThrow()

  // Tous les serveurs déjà déclarés sont des VPS. Supposer du mutualisé leur
  // retirerait en silence quatre opérations qu'ils utilisent.
  expect(row.type_hebergement).toBe('vps')
  expect(row.hebergeur).toBeNull()
  expect(row.client_id).toBeNull()
})

test('supprimer une fiche client ne fait pas disparaître son serveur', async () => {
  const client = await db
    .insertInto('clients')
    .values({ name: 'Bastide' })
    .returning('id')
    .executeTakeFirstOrThrow()
  await db
    .insertInto('serveurs')
    .values({
      nom: 'bastide-mutu',
      hote: 'h',
      utilisateur: 'u',
      type_hebergement: 'mutualise',
      hebergeur: 'planethoster',
      client_id: client.id,
    })
    .execute()

  await db.deleteFrom('clients').where('id', '=', client.id).execute()

  // `set null` et non `cascade` : le serveur existe toujours et continue de
  // servir des sites. Le faire disparaître avec la fiche serait une perte de
  // données déguisée en nettoyage.
  const survit = await db
    .selectFrom('serveurs')
    .select(['client_id', 'hebergeur'])
    .where('nom', '=', 'bastide-mutu')
    .executeTakeFirstOrThrow()
  expect(survit.client_id).toBeNull()
  expect(survit.hebergeur).toBe('planethoster')
})

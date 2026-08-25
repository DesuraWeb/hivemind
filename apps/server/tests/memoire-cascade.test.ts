import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { proposerSavoirs } from '../src/knowledge/propose'
import { nommerCouple, savoirsDeStack } from '../src/knowledge/stack-rules'
import { archiver, corriger } from '../src/knowledge/store'
import { recetteComplete } from '../src/ops/recipes'

/**
 * La mémoire de déploiement, indexée sur le bon couple (Lot A).
 *
 * ## Le problème, dans les mots de Florian
 *
 * « Je déploie Astro sur un PlanetHoster · on va voir qu'il y aura des
 * problématiques de version PHP. »
 *
 * Ce n'est pas un fait sur Astro : sur un VPS il n'y a aucun PHP. Rangé sous
 * `stack = 'astro'` — la seule clé qui existait — ce savoir serait rappelé à
 * contretemps une fois sur deux. Et **un rappel faux coûte plus cher qu'un
 * rappel absent** : il fait perdre du temps ET décrédibilise ceux qui
 * l'accompagnent.
 *
 * Ce fichier garde les deux propriétés qui font qu'on peut faire confiance à
 * cette mémoire : le plus précis gagne, et **ce qui vise un autre hébergement
 * est écarté, jamais rétrogradé**.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)

  const universel = {
    cercle: 'hive' as const,
    domaine: 'exploitation' as const,
    stack: 'astro',
  }
  await archiver(db, {
    ...universel,
    sujet: 'robots',
    contenu: 'Poser robots.txt dès le premier déploiement.',
  })
  await archiver(db, {
    ...universel,
    hebergement: 'mutualise',
    sujet: 'chemins',
    contenu: 'Le document root est dans public_html, pas à la racine du compte.',
  })
  await archiver(db, {
    ...universel,
    hebergement: 'planethoster',
    sujet: 'php',
    contenu: 'La version PHP par défaut est trop basse · la monter depuis le panneau.',
  })
  await archiver(db, {
    ...universel,
    hebergement: 'o2switch',
    sujet: 'cron',
    contenu: 'Les crons passent par le panneau, pas par crontab.',
  })
})

afterAll(async () => {
  await db.destroy()
})

const ou = { hebergeur: 'planethoster', type: 'mutualise' }

test('sans contexte, seuls les savoirs universels remontent', async () => {
  // Préserve l'appelant historique : le cadrage d'un dev n'a aucun contexte
  // d'hébergement, et une contrainte propre à PlanetHoster n'a rien à y faire.
  // Ajouter un niveau à la mémoire ne doit pas changer le prompt d'un rôle qui
  // n'a rien demandé.
  const lignes = await savoirsDeStack(db, 'Astro 5', 'exploitation')
  expect(lignes).toHaveLength(1)
  expect(lignes[0]).toContain('robots')
})

test('la cascade rend les trois niveaux, le plus précis en tête', async () => {
  const lignes = await savoirsDeStack(db, 'Astro 5', 'exploitation', ou)
  expect(lignes).toHaveLength(3)
  // Un agent qui lit une liste pondère le haut : l'ordre EST une information.
  expect(lignes[0]).toContain('php')
  expect(lignes[1]).toContain('chemins')
  expect(lignes[2]).toContain('robots')
})

test('la portée est dite sur la ligne', async () => {
  const lignes = await savoirsDeStack(db, 'Astro 5', 'exploitation', ou)
  expect(lignes[0]).toContain('(chez planethoster)')
  expect(lignes[1]).toContain('(sur mutualise)')
  // L'universel n'est pas préfixé : le bruit ne se paie que quand il informe.
  expect(lignes[2]?.startsWith('- robots')).toBe(true)
})

test('un savoir d’un autre hébergeur est écarté, jamais rétrogradé', async () => {
  // Le cœur du lot. `o2switch` ne doit PAS remonter chez PlanetHoster, même
  // pas en bas de liste : rétrograder au lieu d'écarter redonnerait exactement
  // le rappel faux qu'on cherche à supprimer.
  const lignes = await savoirsDeStack(db, 'Astro 5', 'exploitation', ou)
  expect(lignes.join('\n')).not.toContain('cron')
})

test('sur un VPS, rien de ce qui vise le mutualisé ne remonte', async () => {
  // L'exemple de Florian, à l'envers : Astro sur un VPS n'a aucun PHP, donc
  // « monter la version PHP » ne doit pas l'atteindre.
  const lignes = await savoirsDeStack(db, 'Astro 5', 'exploitation', {
    hebergeur: 'ovh',
    type: 'vps',
  })
  expect(lignes).toHaveLength(1)
  expect(lignes[0]).toContain('robots')
})

test('le domaine reste étanche', async () => {
  // La cascade s'ajoute au filtre par domaine, elle ne le remplace pas : un
  // cadrage de code ne doit toujours pas recevoir de savoirs d'exploitation.
  const lignes = await savoirsDeStack(db, 'Astro 5', 'code', ou)
  expect(lignes).toEqual([])
})

test('le vide se dit quand le couple est neuf', async () => {
  const texte = await recetteComplete(db, 'Symfony 7', { hebergeur: 'ionos', type: 'mutualise' })
  // Un silence est indistinguable de la confiance : « rien à signaler » et
  // « je n'ai jamais fait ça » mèneraient au même prompt, et pas au même plan.
  expect(texte).toContain('Ce couple est neuf')
  expect(texte).toContain('Symfony 7 chez ionos')
  expect(texte).toContain('découvrir')
})

test('le vide ne se dit pas quand on ne sait pas où on déploie', async () => {
  // Sans contexte d'hébergement, annoncer « ce couple est neuf » serait une
  // affirmation gratuite : on ne sait pas de quel couple il s'agit.
  const texte = await recetteComplete(db, 'Symfony 7')
  expect(texte ?? '').not.toContain('Ce couple est neuf')
})

test('un couple déjà connu ne se déclare pas neuf', async () => {
  const texte = await recetteComplete(db, 'Astro 5', ou)
  expect(texte).toContain('php')
  expect(texte).not.toContain('Ce couple est neuf')
})

test('corriger un savoir conserve sa portée', async () => {
  const v1 = await archiver(db, {
    cercle: 'hive',
    domaine: 'exploitation',
    stack: 'laravel',
    hebergement: 'planethoster',
    sujet: 'queue',
    contenu: 'Pas de démon possible · la queue tourne en cron.',
  })
  await corriger(db, v1.racineId, 'Pas de supervisor ici · la queue tourne par cron minute.')

  // Reformuler un savoir ne doit pas lui faire changer de portée : il
  // deviendrait universel en silence et serait rappelé partout.
  const lignes = await savoirsDeStack(db, 'Laravel 12', 'exploitation', ou)
  expect(lignes[0]).toContain('(chez planethoster)')
  expect(lignes[0]).toContain('cron minute')

  const surVps = await savoirsDeStack(db, 'Laravel 12', 'exploitation', { type: 'vps' })
  expect(surVps).toEqual([])
})

test('nommer un couple, pour pouvoir dire qu’on ne le connaît pas', () => {
  expect(nommerCouple('Astro 5', { hebergeur: 'planethoster', type: 'mutualise' })).toBe(
    'Astro 5 chez planethoster',
  )
  expect(nommerCouple('Astro 5', { type: 'vps' })).toBe('Astro 5 sur vps')
  expect(nommerCouple('Astro 5')).toBe('Astro 5')
})

test('corriger un savoir conserve son domaine', async () => {
  // Trouvé en écrivant le test de portée, et c'est un bug PRÉEXISTANT :
  // `corriger` ne recopiait pas `domaine`, donc la nouvelle version retombait
  // sur le défaut de colonne (`code`). Reformuler un savoir d'exploitation le
  // faisait basculer en silence dans la mémoire du dev — invisible pour l'agent
  // ops qui venait de l'apprendre, et du bruit pour le garant qui ne l'a jamais
  // demandé.
  const v1 = await archiver(db, {
    cercle: 'hive',
    domaine: 'exploitation',
    stack: 'symfony',
    sujet: 'opcache',
    contenu: 'Vider l’opcache après déploiement, sinon l’ancien code reste servi.',
  })
  const v2 = await corriger(db, v1.racineId, 'Vider l’opcache après chaque déploiement.')
  expect(v2.domaine).toBe('exploitation')
})

test('la portée est dite à l’écran, là où elle se corrige', async () => {
  // Le seul endroit où Florian voit un savoir avant qu'il n'entre en mémoire.
  // Un savoir rangé trop bas devient presque invisible ensuite, et rien ne
  // dirait pourquoi il ne remonte jamais.
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Atelier', slug: `atelier-${Date.now() % 100000}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const projet = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Essai',
      slug: `essai-${Date.now() % 100000}`,
      repo_full_name: 'd/e',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const { proposes } = await proposerSavoirs(db, {
    projectId: projet.id,
    // Hors boucle : l'exploitation apprend en dehors d'un run.
    runId: null,
    candidats: [
      {
        sujet: 'node',
        contenu: 'La version de Node du compte est figée · demander la bascule au support.',
        cercle: 'hive',
        stack: 'astro',
        hebergement: 'planethoster',
      },
    ],
    fromRole: 'ops',
    domaine: 'exploitation',
  })

  const ctx = String((proposes[0]?.payload as { ctx?: unknown }).ctx)
  expect(ctx).toContain('astro uniquement sur « planethoster »')
})

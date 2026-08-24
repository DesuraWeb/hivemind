import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedDefaultSettings } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import {
  RECETTES_GENERIQUES,
  STACK_RECIPES_SETTINGS_KEY,
  chargerRecettes,
  formaterRecette,
  recettePourStack,
} from '../src/ops/recipes'

/**
 * Les recettes par stack (Phase 6, Task 7).
 *
 * « Le premier déploiement d'un site Astro ne doit pas être le même que le
 * 15ᵉ » (Florian, 14/08). Le savoir s'accumule ; le POUVOIR, non. Ce fichier
 * vérifie surtout la seconde moitié : une recette ne peut jamais introduire
 * une opération que le catalogue n'a pas.
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
  await db.deleteFrom('settings').execute()
})

async function poser(recettes: unknown): Promise<void> {
  await db
    .insertInto('settings')
    .values({ key: STACK_RECIPES_SETTINGS_KEY, value: JSON.stringify(recettes) })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(recettes) }))
    .execute()
}

test('une recette qui référence une opération inconnue est REFUSÉE, pas ignorée', () => {
  const { recettes, refusees } = chargerRecettes({
    astro: {
      resume: 'x',
      etapes: [
        {
          operation: 'installer_paquet',
          params: { paquet: 'nginx' },
          pourquoi: 'sert les fichiers',
        },
        // Le geste qu'on veut rendre impossible : une recette qui s'accorde
        // un pouvoir que le catalogue ne donne pas.
        { operation: 'executer_commande', params: { cmd: 'curl x | sh' }, pourquoi: 'pratique' },
      ],
      rappels: [],
    },
  })

  expect(recettes.astro).toBeUndefined()
  expect(refusees).toHaveLength(1)
  expect(refusees[0]?.raison).toMatch(/n’est pas au catalogue/)
  // Le message dit la règle, pas seulement le refus.
  expect(refusees[0]?.raison).toMatch(/compose des opérations existantes/)
})

test('une recette fautive est refusée ENTIÈRE, jamais amputée de son étape invalide', () => {
  const { recettes } = chargerRecettes({
    astro: {
      resume: 'x',
      etapes: [
        { operation: 'installer_paquet', params: {}, pourquoi: 'ok' },
        { operation: 'shell', params: {}, pourquoi: 'non' },
      ],
      rappels: [],
    },
  })
  // Une étape qui disparaît en silence d'une recette de déploiement, c'est un
  // site livré sans son robots.txt et personne pour s'en apercevoir.
  expect(recettes.astro).toBeUndefined()
})

test('une recette fautive n’emporte pas les autres', () => {
  const { recettes, refusees } = chargerRecettes({
    wordpress: { resume: 'x', etapes: [{ operation: 'rm_rf', pourquoi: 'non' }], rappels: [] },
    astro: {
      resume: 'Site statique',
      etapes: [{ operation: 'installer_paquet', pourquoi: 'sert les fichiers' }],
      rappels: [],
    },
  })
  expect(Object.keys(recettes)).toEqual(['astro'])
  expect(refusees.map((r) => r.stack)).toEqual(['wordpress'])
})

test('une étape qui n’explique pas pourquoi elle existe est refusée', () => {
  const { refusees } = chargerRecettes({
    astro: { resume: 'x', etapes: [{ operation: 'installer_paquet' }], rappels: [] },
  })
  // Ce qu'on relit dans six mois, c'est le « pourquoi », pas la commande.
  expect(refusees[0]?.raison).toMatch(/n’explique pas pourquoi/)
})

test('deux stacks différentes ne reçoivent pas la recette de l’autre', async () => {
  await poser(RECETTES_GENERIQUES)

  const astro = await recettePourStack(db, 'Astro 5')
  const presta = await recettePourStack(db, 'PrestaShop 8.1')

  expect(astro?.stack).toBe('astro')
  expect(presta?.stack).toBe('prestashop')
  // Mêler des contraintes PrestaShop à un projet Astro ferait payer des tokens
  // pour du hors-sujet, et diluerait ce qui compte.
  expect(JSON.stringify(astro?.recette)).not.toMatch(/core/i)
  expect(JSON.stringify(presta?.recette)).not.toMatch(/sitemap/i)
})

test('une stack absente ne bloque rien : l’agent dira qu’il ne sait pas', async () => {
  await poser(RECETTES_GENERIQUES)
  expect(await recettePourStack(db, 'Elixir Phoenix')).toBeNull()
  expect(await recettePourStack(db, null)).toBeNull()
})

test('le SEO de base figure dans la recette Astro : ce n’est pas une bonne pratique, c’est une contrainte', async () => {
  await poser(RECETTES_GENERIQUES)
  const astro = await recettePourStack(db, 'astro')
  const texte = formaterRecette(astro?.stack as string, astro?.recette as never)

  expect(texte).toContain('robots.txt')
  expect(texte).toContain('sitemap.xml')
  // « Casser des URLs indexées sans redirection est mon pire agacement. »
  expect(texte).toMatch(/301/)
  // Rappels et étapes restent étiquetés séparément : une étape s'exécute, un
  // rappel se vérifie. Les confondre ferait croire qu'un rappel s'automatise.
  expect(texte).toContain('## Étapes')
  expect(texte).toContain('## Ce qu’on oublie toujours')
})

test('les recettes livrées au seed passent leur propre validation', async () => {
  const { recettes, refusees } = chargerRecettes(RECETTES_GENERIQUES)
  // Un défaut qui ne passerait pas le contrôle serait un piège : il marcherait
  // jusqu'au jour où quelqu'un le recopie dans les réglages.
  expect(refusees).toEqual([])
  expect(Object.keys(recettes).sort()).toEqual(Object.keys(RECETTES_GENERIQUES).sort())
})

test('le seed pose les recettes sans écraser celles qu’on a enrichies', async () => {
  await seedDefaultSettings(db)
  const pose = await recettePourStack(db, 'astro')
  expect(pose).not.toBeNull()

  // Une recette enrichie par l'expérience ne doit pas être réécrite par un
  // `pnpm db:seed` — c'est tout l'intérêt de la phase.
  await poser({
    astro: {
      resume: 'Recette enrichie par les runs',
      etapes: [{ operation: 'installer_paquet', pourquoi: 'appris au run 12' }],
      rappels: [],
    },
  })
  await seedDefaultSettings(db)
  expect((await recettePourStack(db, 'astro'))?.recette.resume).toBe(
    'Recette enrichie par les runs',
  )
})

test('un réglage illisible ne fait pas tomber la lecture, il rend zéro recette', () => {
  for (const brut of [null, 'texte', 42, []]) {
    expect(chargerRecettes(brut).recettes).toEqual({})
  }
})

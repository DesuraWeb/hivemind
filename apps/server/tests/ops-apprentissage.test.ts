import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { type InboxItemRow, listInbox } from '../src/inbox/repo'
import { archiverSavoirApprouve } from '../src/knowledge/propose'
import { savoirsDeStack } from '../src/knowledge/stack-rules'
import type { ResultatApplication } from '../src/ops/apply'
import { apprendreDeLEchec, apprendreDuJuge, apprendreDuRetour } from '../src/ops/apprendre'
import type { RapportProvision } from '../src/ops/provision'
import {
  RECETTES_GENERIQUES,
  STACK_RECIPES_SETTINGS_KEY,
  recetteComplete,
} from '../src/ops/recipes'
import { ensureGlobe } from './fixtures'

/**
 * La boucle qui remplit les recettes (Phase 6, Task 7 · seconde moitié).
 *
 * « Le premier déploiement d'un site Astro ne doit pas être le même que le
 * 15ᵉ » (Florian, 14/08). Ce fichier vérifie que quelque chose remonte
 * réellement — et surtout que ce qui remonte est du TEXTE, jamais une
 * opération : une étape s'exécuterait en champ libre sur le prochain serveur
 * vierge, et l'ajouter sans décision humaine serait du pouvoir qui s'élargit
 * tout seul.
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
  await db.deleteFrom('savoirs').execute()
  await db.deleteFrom('inbox_items').execute()
  await db.deleteFrom('settings').execute()
  await db
    .insertInto('settings')
    .values({
      key: STACK_RECIPES_SETTINGS_KEY,
      value: JSON.stringify(RECETTES_GENERIQUES),
    })
    .execute()
})

async function creerProjet(stack: string | null): Promise<string> {
  const globe = await ensureGlobe(db)
  const row = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Vitrine',
      slug: `p-apprend-${randomUUID()}`,
      repo_full_name: 'desura/vitrine',
      ...(stack ? { stack } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

/** Approuve un item de savoir et l'archive, comme le fait la route d'inbox. */
async function approuverEtArchiver(item: InboxItemRow, texte?: string): Promise<void> {
  await db
    .updateTable('inbox_items')
    .set({
      status: 'done',
      human_response: JSON.stringify({ approved: true, ...(texte ? { text: texte } : {}) }),
      resolved_at: new Date(),
    })
    .where('id', '=', item.id)
    .execute()

  const relu = (await listInbox(db, {})).find((i) => i.id === item.id)
  await archiverSavoirApprouve(db, relu as InboxItemRow)
}

const RAPPORT: RapportProvision = {
  conformites: ['nginx installé'],
  ecarts: [
    {
      severite: 'bloquant',
      constat: 'aucun robots.txt servi à la racine',
      preuve: 'GET /robots.txt → 404',
    },
    {
      severite: 'mineur',
      constat: 'version de nginx plus ancienne que prévu',
      preuve: '1.18 vs 1.24',
    },
  ],
}

// --- Source 1 · le juge -----------------------------------------------------

test('un écart bloquant du juge devient une proposition de rappel', async () => {
  const projectId = await creerProjet('Astro 5')
  const n = await apprendreDuJuge({ db, projectId, stack: 'astro' }, RAPPORT)

  expect(n).toBe(1)
  const items = await listInbox(db, { type: 'approval' })
  expect(items).toHaveLength(1)
  expect(items[0]?.subtype).toBe('savoir')
  // Le rôle qui a trouvé, pas 'system' : l'UI l'affiche à côté du titre.
  expect(items[0]?.fromRole).toBe('ops')

  const savoir = items[0]?.payload.savoir as Record<string, unknown>
  expect(savoir.stack).toBe('astro')
  // Rangé dans la mémoire d'exploitation, pas dans celle du dev.
  expect(savoir.domaine).toBe('exploitation')
  // La preuve voyage avec le constat : un rappel qu'on ne peut pas contester
  // dans six mois est un rappel qu'on finira par subir.
  expect(savoir.contenu).toContain('GET /robots.txt → 404')
})

test('un écart mineur ne remonte pas : ce n’est pas une leçon', async () => {
  const projectId = await creerProjet('Astro 5')
  await apprendreDuJuge({ db, projectId, stack: 'astro' }, RAPPORT)

  const items = await listInbox(db, { type: 'approval' })
  // Un seul item : le bloquant. Remonter chaque détail transformerait la revue
  // du matin en liste de courses.
  expect(items).toHaveLength(1)
  expect(items[0]?.payload.cause).not.toMatch(/version de nginx/)
})

test('sans stack, rien ne remonte : le savoir n’atteindrait aucune recette', async () => {
  const projectId = await creerProjet(null)
  expect(await apprendreDuJuge({ db, projectId, stack: null }, RAPPORT)).toBe(0)
  expect(await listInbox(db, {})).toHaveLength(0)
})

// --- Source 2 · l'arbitrage de Florian --------------------------------------

function itemOps(projectId: string, reponse: Record<string, unknown>): InboxItemRow {
  return {
    id: randomUUID(),
    type: 'approval',
    subtype: 'ops',
    projectId,
    runId: null,
    title: 'srv-client · 2 opérations à valider',
    fromRole: 'ops',
    payload: {},
    status: 'done',
    humanResponse: reponse,
    createdAt: new Date(),
    blockedSince: new Date(),
    resolvedAt: new Date(),
    archiveToClient: false,
  }
}

test('un refus MOTIVÉ remonte : c’est un arbitrage qu’aucun agent n’aurait deviné', async () => {
  const projectId = await creerProjet('PrestaShop 8.1')
  const n = await apprendreDuRetour(
    { db, projectId, stack: 'prestashop' },
    itemOps(projectId, {
      approved: false,
      text: 'Jamais de cron sur ce serveur, le client a son propre ordonnanceur externe.',
    }),
  )

  expect(n).toBe(1)
  const savoir = (await listInbox(db, {}))[0]?.payload.savoir as Record<string, unknown>
  expect(savoir.contenu).toContain('ordonnanceur externe')
  expect(savoir.contenu).toContain('refusé')
})

test('un refus sec et un oui silencieux ne remontent rien', async () => {
  const projectId = await creerProjet('PrestaShop 8.1')

  // « Non » sans « parce que » ne porte aucune leçon.
  expect(
    await apprendreDuRetour(
      { db, projectId, stack: 'prestashop' },
      itemOps(projectId, { approved: false }),
    ),
  ).toBe(0)
  // Un oui silencieux est le cas NORMAL : en tirer un savoir remplirait la
  // mémoire de confirmations sans contenu.
  expect(
    await apprendreDuRetour(
      { db, projectId, stack: 'prestashop' },
      itemOps(projectId, { approved: true }),
    ),
  ).toBe(0)
  // Trop court pour être un arbitrage.
  expect(
    await apprendreDuRetour(
      { db, projectId, stack: 'prestashop' },
      itemOps(projectId, { approved: false, text: 'non' }),
    ),
  ).toBe(0)

  expect(await listInbox(db, {})).toHaveLength(0)
})

// --- Source 3 · ce qui a cassé ----------------------------------------------

const ECHEC: ResultatApplication = {
  ok: false,
  appliquees: [
    {
      nom: 'installer_paquet',
      resume: 'Installer le paquet php8.2-gd',
      commande: "DEBIAN_FRONTEND=noninteractive apt-get install -y 'php8.2-gd'",
      sauvegarde: null,
      inverse: null,
      code: 1,
      sortie: '',
      erreur: 'E: Unable to locate package php8.2-gd\nsuite ignorée',
    },
  ],
  nonTentees: ['recharger_service'],
  echec: {
    nom: 'installer_paquet',
    code: 1,
    erreur: 'E: Unable to locate package php8.2-gd\nsuite ignorée',
    retourArriere: [],
    irreversibles: [],
  },
}

test('une opération qui casse remonte, avec sa sortie d’erreur', async () => {
  const projectId = await creerProjet('PrestaShop 8.1')
  const n = await apprendreDeLEchec({ db, projectId, stack: 'prestashop' }, ECHEC)

  expect(n).toBe(1)
  const savoir = (await listInbox(db, {}))[0]?.payload.savoir as Record<string, unknown>
  // La première ligne de l'erreur seulement : c'est elle qui dit pourquoi.
  expect(savoir.contenu).toContain('Unable to locate package php8.2-gd')
  expect(savoir.contenu).not.toContain('suite ignorée')
})

test('un succès n’apprend rien', async () => {
  const projectId = await creerProjet('PrestaShop 8.1')
  expect(
    await apprendreDeLEchec(
      { db, projectId, stack: 'prestashop' },
      { ok: true, appliquees: [], nonTentees: [] },
    ),
  ).toBe(0)
})

// --- Ce qui arrive au bout : la recette enrichie -----------------------------

test('un rappel validé rejoint la recette, étiqueté comme APPRIS', async () => {
  const projectId = await creerProjet('Astro 5')
  await apprendreDuJuge({ db, projectId, stack: 'astro' }, RAPPORT)
  const item = (await listInbox(db, {}))[0] as InboxItemRow
  await approuverEtArchiver(item)

  const texte = (await recetteComplete(db, 'Astro 5')) as string

  // Le socle écrit à la main et ce qui a été appris restent DISTINCTS : une
  // règle posée par Florian n'a pas le même poids qu'une observation tirée
  // d'un déploiement, et les confondre empêcherait de corriger la bonne.
  expect(texte).toContain('## Étapes')
  expect(texte).toContain('## Ce qu’on oublie toujours')
  expect(texte).toContain('## Appris sur les déploiements précédents')
  expect(texte).toContain('robots.txt servi à la racine')
})

test('la formulation de Florian écrase celle de l’agent', async () => {
  const projectId = await creerProjet('Astro 5')
  await apprendreDuJuge({ db, projectId, stack: 'astro' }, RAPPORT)
  const item = (await listInbox(db, {}))[0] as InboxItemRow
  await approuverEtArchiver(item, 'Poser robots.txt ET sitemap.xml avant toute mise en ligne.')

  const texte = (await recetteComplete(db, 'astro')) as string
  expect(texte).toContain('Poser robots.txt ET sitemap.xml')
  // Celle de l'agent n'est jamais archivée quand Florian en a donné une.
  expect(texte).not.toContain('GET /robots.txt → 404')
})

test('ce qu’un dev apprend et ce qu’un déploiement apprend ne se mélangent pas', async () => {
  const projectId = await creerProjet('Astro 5')
  await apprendreDuJuge({ db, projectId, stack: 'astro' }, RAPPORT)
  await approuverEtArchiver((await listInbox(db, {}))[0] as InboxItemRow)

  // Le cadrage d'un dev ne voit pas le rappel de déploiement...
  expect(await savoirsDeStack(db, 'Astro 5')).toEqual([])
  // ...et la mémoire d'exploitation le voit.
  expect((await savoirsDeStack(db, 'Astro 5', 'exploitation')).join('\n')).toContain('robots.txt')
})

test('une stack sans recette écrite profite quand même de ce qui a été appris', async () => {
  const projectId = await creerProjet('Elixir Phoenix')
  await apprendreDuJuge({ db, projectId, stack: 'phoenix' }, RAPPORT)
  await approuverEtArchiver((await listInbox(db, {}))[0] as InboxItemRow)

  const texte = (await recetteComplete(db, 'Elixir Phoenix')) as string
  // Mieux que rien, et bien mieux qu'une recette inventée : l'agent sait au
  // moins ce qui a déjà cassé.
  expect(texte).toContain('aucune recette écrite')
  expect(texte).toContain('robots.txt')
})

test('AUCUNE étape n’est jamais ajoutée automatiquement : c’est la ligne', async () => {
  const projectId = await creerProjet('Astro 5')
  await apprendreDuJuge({ db, projectId, stack: 'astro' }, RAPPORT)
  await apprendreDeLEchec({ db, projectId, stack: 'astro' }, ECHEC)
  for (const item of await listInbox(db, {})) await approuverEtArchiver(item)

  // La recette STOCKÉE n'a pas bougé d'un pouce : les étapes du socle, et
  // elles seules. C'est là qu'une opération ajoutée toute seule se verrait.
  const brut = await db
    .selectFrom('settings')
    .select('value')
    .where('key', '=', STACK_RECIPES_SETTINGS_KEY)
    .executeTakeFirstOrThrow()
  const stockee = (brut.value as Record<string, { etapes: unknown[] } | undefined>).astro
  expect(stockee?.etapes).toHaveLength(RECETTES_GENERIQUES.astro?.etapes.length ?? 0)

  // Et ce qui a été appris reste ENTIÈREMENT sous « Appris » : rien n'a
  // rejoint la section des étapes, qui est la seule qui s'exécute.
  //
  // Le nom d'une opération PEUT apparaître dans le texte appris (« l'opération
  // installer_paquet a échoué ») : c'est une phrase qu'on lit, pas une étape
  // qu'on exécute. Confondre les deux ferait échouer ce test pour la mauvaise
  // raison — ce qu'on surveille est la section, pas le mot.
  const texte = (await recetteComplete(db, 'astro')) as string
  const etapes = texte.slice(texte.indexOf('## Étapes'), texte.indexOf('## Ce qu’on oublie'))
  expect(etapes).toContain('installer_paquet · Sert les fichiers générés')
  expect(etapes.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(
    RECETTES_GENERIQUES.astro?.etapes.length ?? 0,
  )
  expect(etapes).not.toContain('robots.txt servi à la racine')
})

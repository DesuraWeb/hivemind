import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { tourDeCreation } from '../src/creation/conversation'
import { appliquerRetouche, etapeFiche, manquesFiche } from '../src/creation/fiche'
import { CREATION_MCP_SERVER, createSurfaceCreation } from '../src/creation/outils'
import { cloturerCreation, ouvrirCreation } from '../src/creation/repo'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { createGlobe } from '../src/globes/repo'
import { createProject } from '../src/projects/create'
import { createFakeAdapter } from '../src/runtime/fake'
import type { RuntimeAdapter } from '../src/runtime/types'
import { ensureGlobe } from './fixtures'

/**
 * La conversation de création (Lot 1).
 *
 * ## Ce qui n'existait pas
 *
 * L'écran rejouait cinq `setTimeout` et un bouton « rejouer la conversation ».
 * Aucun agent n'écoutait cet écran, et le prompt du majordome lui demandait
 * pourtant d'appeler `create_project_draft` — un outil qui n'a jamais existé.
 *
 * ## Le trou que ce fichier NE bouche pas, et il faut le dire
 *
 * Le faux adaptateur n'exécute pas les serveurs MCP en process : il rapporte
 * un appel d'outil sans le faire. La chaîne « Hive appelle `proposer_fiche` →
 * la fiche se remplit » n'est donc pas exercée de bout en bout ici. On teste
 * ses deux moitiés — la forme de la surface, et l'application des retouches,
 * qui est pure — plus tout ce qui les entoure. C'est la limite de l'outillage
 * de test du dépôt, pas un choix.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const app = await buildApp({ db })
let cookie: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await seedRoleTemplates(db)
  await createUser(db, 'florian', 'motdepasse-de-test')
  await app.ready()
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  cookie = login.cookies.find((c) => c.name === 'hm_session')?.value as string
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

const auth = () => ({ cookie: `hm_session=${cookie}` })

/**
 * Le slug d'une orbe utilisable.
 *
 * `ensureGlobe` rend le vrai identifiant de ligne, alors que `createGlobe`
 * rend le SLUG sous la clé `id` (`GlobeView`). Les deux ne sont pas
 * interchangeables et `createProject` n'accepte que le slug : on le relit
 * plutôt que de parier sur l'un ou l'autre.
 */
async function slugDuGlobe(): Promise<string> {
  const g = await ensureGlobe(db)
  const row = await db
    .selectFrom('globes')
    .select('slug')
    .where('id', '=', g.id)
    .executeTakeFirstOrThrow()
  return row.slug
}

/** Aucune sortie réseau depuis un test : la sonde répond toujours « rien ». */
const httpMuet = async () => ({ erreur: 'sonde neutralisée en test' })

// ─── La fiche, en pur ───────────────────────────────────────────────────────

test('apprendre le dépôt n’efface pas le nom appris trois tours plus tôt', () => {
  let f = appliquerRetouche({}, { projet: { nom: 'Boutique Bastide' } })
  f = appliquerRetouche(f, { projet: { depot: 'desura/bastide' } })
  expect(f.projet).toEqual({ nom: 'Boutique Bastide', depot: 'desura/bastide' })
})

test('une liste se remplace en entier, jamais élément par élément', () => {
  // Le pire cas qu'on refuse : un step retiré par Hive qui réapparaît parce
  // que la fusion ne savait pas qu'il fallait l'oublier.
  let f = appliquerRetouche(
    {},
    {
      steps: [
        { titre: 'Un', specs: '' },
        { titre: 'Deux', specs: '' },
      ],
    },
  )
  f = appliquerRetouche(f, { steps: [{ titre: 'Un', specs: '' }] })
  expect(f.steps).toHaveLength(1)
})

test('un champ absent ne fait rien, une chaîne vide efface', () => {
  let f = appliquerRetouche({}, { projet: { nom: 'Essai', stack: 'astro' } })
  f = appliquerRetouche(f, { projet: { depot: 'desura/essai' } })
  expect(f.projet?.stack).toBe('astro')
  f = appliquerRetouche(f, { projet: { stack: '' } })
  expect(f.projet?.stack).toBe('')
})

test('ce qui manque est dit en clair, et rien n’est deviné', () => {
  expect(manquesFiche({})).toContain('le nom du projet')
  expect(manquesFiche({})).toContain('le dépôt')
  const complete = {
    projet: { nom: 'Essai', depot: 'desura/essai', orbe: 'atelier' },
    steps: [{ titre: 'Un pas', specs: 'des specs' }],
  }
  expect(manquesFiche(complete)).toEqual([])
})

test('l’étape vient de ce que la fiche contient, jamais d’une horloge', () => {
  expect(etapeFiche({})).toBe(0)
  expect(etapeFiche({ projet: { nom: 'Essai' } })).toBe(1)
  expect(etapeFiche({ projet: { nom: 'Essai', stack: 'astro' } })).toBe(2)
  expect(
    etapeFiche({
      projet: { nom: 'Essai', depot: 'desura/essai', orbe: 'atelier' },
      steps: [{ titre: 'Un pas', specs: 's' }],
    }),
  ).toBe(5)
})

// ─── La surface ─────────────────────────────────────────────────────────────

test('la surface expose exactement ce qui est prévu, et rien d’irréversible', () => {
  const surface = createSurfaceCreation({ db, http: httpMuet, ficheInitiale: {} })
  expect(surface.toolNames.sort()).toEqual([
    'creer_orbe',
    'creer_projet',
    'lire_contexte',
    'proposer_fiche',
    'sonder_url',
    'verifier_depot',
  ])
  const appelables = new Set(surface.sendOptions.extraAllowedTools ?? [])
  // Ce que Hive ne peut PAS faire : rien ne supprime, rien ne déploie, rien ne
  // touche un run. Créer une orbe et un projet est réversible d'un geste
  // (`globe_id`/`project_id` sur la création) ; le reste ne l'est pas.
  for (const interdit of ['supprimer_projet', 'demarrer_run', 'deployer', 'lire_secret']) {
    expect(appelables.has(`mcp__${CREATION_MCP_SERVER}__${interdit}`)).toBe(false)
  }
})

// ─── Les routes ─────────────────────────────────────────────────────────────

test('ouvrir une création donne une première réplique, et elle est gratuite', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/creations', headers: auth() })
  expect(r.statusCode).toBe(201)
  const c = r.json()
  expect(c.conversation).toHaveLength(1)
  expect(c.conversation[0].de).toBe('hive')
  // Faire produire « on crée quoi ? » par un modèle coûterait un échange pour
  // une phrase qui ne dépend de rien.
  expect(c.costTokens).toBe(0)
  expect(c.etape).toBe(0)
})

test('un rafraîchissement retombe sur la conversation en cours', async () => {
  const ouverte = await app.inject({ method: 'POST', url: '/api/creations', headers: auth() })
  const id = ouverte.json().id
  const r = await app.inject({ method: 'GET', url: '/api/creations/en-cours', headers: auth() })
  // La plus récente : une discussion payée à un modèle ne doit pas disparaître
  // parce qu'un onglet s'est fermé.
  expect(r.json().id).toBe(id)
})

test('un tour nominal fait grandir le fil et coûte des jetons', async () => {
  const id = (await app.inject({ method: 'POST', url: '/api/creations', headers: auth() })).json()
    .id
  const r = await app.inject({
    method: 'POST',
    url: `/api/creations/${id}/message`,
    headers: auth(),
    payload: { texte: 'Une refonte du site de Bastide en Astro.' },
  })

  expect(r.statusCode).toBe(200)
  const c = r.json()
  expect(c.panne).toBe(false)
  expect(c.conversation).toHaveLength(3)
  expect(c.conversation[1]).toMatchObject({ de: 'florian' })
  expect(c.conversation[2].de).toBe('hive')
  // Cumulé, pas écrasé : le budget doit voir la conversation entière.
  expect(c.costTokens).toBeGreaterThan(0)
})

test('le modèle tombe · l’écran le dit, et ce que Florian a écrit est gardé', async () => {
  const creation = await ouvrirCreation(db)

  // Un adaptateur qui tombe. Le chemin nominal est couvert au-dessus par le
  // faux adaptateur de `buildApp` ; celui-ci est le seul moyen d'exercer la
  // panne, que l'environnement de test ne produit jamais tout seul.
  const casse: RuntimeAdapter = {
    ...createFakeAdapter(),
    createSession: async () => {
      throw new Error('budget épuisé · fenêtre de 5 h')
    },
  }

  const { creation: apres, panne } = await tourDeCreation(
    { db, adapter: casse, cwd: '/tmp', http: httpMuet },
    creation.id,
    'Une refonte du site de Bastide en Astro.',
  )

  expect(panne).toBe(true)
  const fil = apres.conversation
  // Ce que Florian a tapé est écrit AVANT l'appel au modèle : il n'est pas
  // perdu quand le modèle tombe juste après.
  expect(fil.at(-2)).toMatchObject({
    de: 'florian',
    texte: 'Une refonte du site de Bastide en Astro.',
  })
  expect(fil.at(-1)?.panne).toBe(true)
  // La cause, pas « une erreur est survenue » : un budget à sec et un modèle
  // injoignable n'appellent pas la même réaction.
  expect(fil.at(-1)?.texte).toContain('budget épuisé')
  // La fiche n'est pas touchée par une panne.
  expect(apres.fiche).toEqual(creation.fiche)
})

test('la correction manuelle écrit la fiche et ne réécrit pas le fil', async () => {
  const id = (await app.inject({ method: 'POST', url: '/api/creations', headers: auth() })).json()
    .id
  await app.inject({
    method: 'POST',
    url: `/api/creations/${id}/message`,
    headers: auth(),
    payload: { texte: 'Bastide.' },
  })
  const avant = (
    await app.inject({ method: 'GET', url: `/api/creations/${id}`, headers: auth() })
  ).json()

  const r = await app.inject({
    method: 'PATCH',
    url: `/api/creations/${id}/fiche`,
    headers: auth(),
    payload: { projet: { nom: 'Boutique Bastide', depot: 'desura/bastide' } },
  })

  expect(r.statusCode).toBe(200)
  const apres = r.json()
  expect(apres.fiche.projet.nom).toBe('Boutique Bastide')
  // Corriger un dépôt ne doit pas falsifier ce que Hive a réellement dit.
  expect(apres.conversation).toEqual(avant.conversation)
  expect(apres.etape).toBeGreaterThan(0)
})

test('une fiche invalide est refusée champ par champ', async () => {
  const id = (await app.inject({ method: 'POST', url: '/api/creations', headers: auth() })).json()
    .id
  const r = await app.inject({
    method: 'PATCH',
    url: `/api/creations/${id}/fiche`,
    headers: auth(),
    payload: { steps: [{ titre: '', specs: 'des specs' }] },
  })
  expect(r.statusCode).toBe(400)
  expect(r.json().details[0].path).toContain('steps.0.titre')
})

test('une création abandonnée refuse un tour de plus', async () => {
  const id = (await app.inject({ method: 'POST', url: '/api/creations', headers: auth() })).json()
    .id
  await app.inject({ method: 'POST', url: `/api/creations/${id}/abandon`, headers: auth() })
  const r = await app.inject({
    method: 'POST',
    url: `/api/creations/${id}/message`,
    headers: auth(),
    payload: { texte: 'Encore un mot.' },
  })
  expect(r.statusCode).toBe(409)
  expect(r.json().error).toBe('creation_close')
})

test('toutes les routes de création exigent une session', async () => {
  for (const [method, url] of [
    ['GET', '/api/creations/en-cours'],
    ['POST', '/api/creations'],
  ] as const) {
    const r = await app.inject({ method, url })
    expect(r.statusCode, `${method} ${url}`).toBe(401)
  }
})

test('annuler défait ce que la conversation a écrit', async () => {
  const globe = await slugDuGlobe()
  const projet = await createProject(db, {
    globeSlug: globe,
    name: 'À défaire',
    repoFullName: 'desura/a-defaire',
    steps: [{ title: 'Un', specs: 's' }],
  })
  const creation = await ouvrirCreation(db)
  await cloturerCreation(db, creation.id, { projectId: projet.id, aboutie: true })

  const r = await app.inject({
    method: 'POST',
    url: `/api/creations/${creation.id}/annuler`,
    headers: auth(),
  })

  expect(r.statusCode).toBe(204)
  // C'est ce qui rend acceptable qu'un agent écrive sans confirmation : sans
  // ce geste, « il s'occupe de tout » voudrait dire « tu nettoies à la main ».
  const reste = await db
    .selectFrom('projects')
    .select('id')
    .where('id', '=', projet.id)
    .executeTakeFirst()
  expect(reste).toBeUndefined()
})

test('annuler refuse dès qu’une boucle a tourné', async () => {
  const globe = await slugDuGlobe()
  const projet = await createProject(db, {
    globeSlug: globe,
    name: 'Déjà lancé',
    repoFullName: 'desura/lance',
    steps: [{ title: 'Un', specs: 's' }],
  })
  const step = await db
    .selectFrom('steps')
    .select('id')
    .where('project_id', '=', projet.id)
    .executeTakeFirstOrThrow()
  await db.insertInto('runs').values({ step_id: step.id, state: 'framing' }).execute()

  const creation = await ouvrirCreation(db)
  await cloturerCreation(db, creation.id, { projectId: projet.id, aboutie: true })

  const r = await app.inject({
    method: 'POST',
    url: `/api/creations/${creation.id}/annuler`,
    headers: auth(),
  })

  // À partir d'un run, ce n'est plus un brouillon de conversation, c'est du
  // travail. Le cascade emporterait runs, messages et artefacts sans le dire.
  expect(r.statusCode).toBe(409)
  expect(r.json().error).toBe('projet_deja_lance')
  const reste = await db
    .selectFrom('projects')
    .select('id')
    .where('id', '=', projet.id)
    .executeTakeFirst()
  expect(reste).toBeDefined()
})

test('annuler laisse l’orbe si un autre projet s’y est posé', async () => {
  const vue = await createGlobe(db, { name: 'Orbe partagée' })
  // `GlobeView.id` porte le SLUG, pas l'identifiant de la ligne : pour écrire
  // `creations.globe_id`, qui est une vraie colonne uuid, il faut le relire.
  const orbe = await db
    .selectFrom('globes')
    .select(['id', 'slug'])
    .where('slug', '=', vue.id)
    .executeTakeFirstOrThrow()
  const mien = await createProject(db, {
    globeSlug: orbe.slug,
    name: 'Le mien',
    repoFullName: 'desura/mien',
  })
  await createProject(db, {
    globeSlug: orbe.slug,
    name: "Celui d'un autre",
    repoFullName: 'desura/autre',
  })

  const creation = await ouvrirCreation(db)
  await cloturerCreation(db, creation.id, {
    globeId: orbe.id,
    projectId: mien.id,
    aboutie: true,
  })
  await app.inject({
    method: 'POST',
    url: `/api/creations/${creation.id}/annuler`,
    headers: auth(),
  })

  // Un projet étranger a pu se poser entre-temps : il n'a rien à voir avec
  // cette conversation, et emporter son orbe l'emporterait avec.
  const survit = await db
    .selectFrom('globes')
    .select('id')
    .where('id', '=', orbe.id)
    .executeTakeFirst()
  expect(survit).toBeDefined()
})

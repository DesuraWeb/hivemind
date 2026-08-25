import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { resolveProjectRole } from '../src/loop/roles'
import { createReviewingHandler } from '../src/loop/steps/reviewing'
import { RosterInvalideError, createProject } from '../src/projects/create'
import { createFakeAdapter } from '../src/runtime/fake'
import type { RuntimeAdapter } from '../src/runtime/types'
import { ensureGlobe } from './fixtures'

/**
 * Le roster et la mémoire semés à la création (Lot 0).
 *
 * ## Ce qui n'existait pas
 *
 * `roles.enabled` est au schéma depuis l'origine et **n'était lu par
 * personne** : décocher un agent ne faisait rien du tout. Et `createProject`
 * n'écrivait ni rôle ni savoir — le roster par défaut arrivait plus tard, par
 * la matérialisation paresseuse de `resolveProjectRole`.
 *
 * C'est le prérequis de « Hive décide qui travaille sur le projet » : sans
 * ça, un agent de création pourrait proposer un roster que rien n'appliquerait.
 *
 * ## Ce que ce fichier garde
 *
 * Que l'écriture d'un roster PRÉEMPTE la matérialisation paresseuse, que les
 * refus soient des refus (rôle indispensable, juge à deux interrupteurs), et
 * qu'un roster invalide n'écrive **rien** — pas un projet à moitié créé.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))

let globeSlug: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await seedRoleTemplates(db)
  const globe = await ensureGlobe(db)
  const row = await db
    .selectFrom('globes')
    .select('slug')
    .where('id', '=', globe.id)
    .executeTakeFirstOrThrow()
  globeSlug = row.slug
})

afterAll(async () => {
  await db.destroy()
})

function base(name: string) {
  return { globeSlug, name, repoFullName: 'desura/essai' }
}

test('sans roster, le comportement d’avant est intact', async () => {
  const projet = await createProject(db, base('Sans roster'))

  // Aucune ligne écrite à la création : c'est la matérialisation paresseuse
  // qui les crée à la première résolution, comme avant.
  const avant = await db
    .selectFrom('roles')
    .select('id')
    .where('project_id', '=', projet.id)
    .execute()
  expect(avant).toHaveLength(0)

  const role = await resolveProjectRole(db, projet.id, 'reviewer')
  expect(role.enabled).toBe(true)
})

test('le roster désactive un rôle, et la boucle le verra', async () => {
  const projet = await createProject(db, {
    ...base('Reviewer coupé'),
    roster: [{ key: 'reviewer', enabled: false }],
  })

  // Le point qui compte : `resolveProjectRole` rend la ligne écrite ici, pas
  // le template. Sans cette préemption, le roster serait décoratif.
  const role = await resolveProjectRole(db, projet.id, 'reviewer')
  expect(role.enabled).toBe(false)

  // Les autres rôles ne sont pas touchés.
  expect((await resolveProjectRole(db, projet.id, 'dev')).enabled).toBe(true)
})

test('un prompt sur mesure remplace celui du template', async () => {
  const projet = await createProject(db, {
    ...base('Prompt sur mesure'),
    roster: [{ key: 'dev', systemPrompt: 'Tu écris du Astro et rien d’autre.' }],
  })

  const role = await resolveProjectRole(db, projet.id, 'dev')
  expect(role.systemPrompt).toBe('Tu écris du Astro et rien d’autre.')
  // Les outils restent ceux du template : on personnalise le discours, pas la
  // surface d'attaque.
  expect(role.tools).not.toEqual({})
})

test('un rôle indispensable ne se désactive pas, et rien n’est écrit', async () => {
  await expect(
    createProject(db, { ...base('Sans dev'), roster: [{ key: 'dev', enabled: false }] }),
  ).rejects.toThrow(RosterInvalideError)

  // La validation a lieu AVANT la transaction : le projet n'existe pas, même
  // pas à moitié. Un projet créé puis rejeté laisserait un slug pris.
  const restes = await db
    .selectFrom('projects')
    .select('id')
    .where('name', '=', 'Sans dev')
    .execute()
  expect(restes).toHaveLength(0)
})

test('le juge refuse le second interrupteur', async () => {
  // `projects.juge_visuel` existe déjà. Deux drapeaux pour une même chose,
  // c'est un jour où les deux se contredisent : on refuse au lieu d'ignorer.
  await expect(
    createProject(db, { ...base('Juge ambigu'), roster: [{ key: 'judge', enabled: false }] }),
  ).rejects.toThrow(/jugeVisuel/)
})

test('les savoirs sont semés dans le bon cercle, avec la bonne instance', async () => {
  const projet = await createProject(db, {
    ...base('Mémoire semée'),
    stack: 'astro',
    savoirs: [
      { cercle: 'projet', sujet: 'ton', contenu: 'Vouvoiement partout.' },
      {
        cercle: 'globe',
        sujet: 'déploiement',
        contenu: 'Toujours un robots.txt au premier déploiement.',
        stack: 'astro',
        domaine: 'exploitation',
      },
    ],
  })

  const semes = await db
    .selectFrom('savoirs')
    .select(['cercle', 'cercle_id', 'sujet', 'domaine', 'stack'])
    .where('sujet', 'in', ['ton', 'déploiement'])
    .execute()

  const projetSavoir = semes.find((s) => s.sujet === 'ton')
  expect(projetSavoir?.cercle).toBe('projet')
  expect(projetSavoir?.cercle_id).toBe(projet.id)
  // `code` par défaut, comme la migration 0012 l'a décidé.
  expect(projetSavoir?.domaine).toBe('code')

  const globeSavoir = semes.find((s) => s.sujet === 'déploiement')
  expect(globeSavoir?.cercle).toBe('globe')
  expect(globeSavoir?.domaine).toBe('exploitation')
  expect(globeSavoir?.stack).toBe('astro')
})

test('un savoir client sans fiche client échoue, et rien ne survit', async () => {
  await expect(
    createProject(db, {
      ...base('Client fantôme'),
      savoirs: [{ cercle: 'client', sujet: 'ton', contenu: 'Tutoiement.' }],
    }),
  ).rejects.toThrow(RosterInvalideError)

  // Celui-ci échoue DANS la transaction, après l'insertion du projet. Le
  // rollback est ce qui distingue « refusé » de « à moitié créé ».
  const restes = await db
    .selectFrom('projects')
    .select('id')
    .where('name', '=', 'Client fantôme')
    .execute()
  expect(restes).toHaveLength(0)
})

test('reviewer désactivé · la revue est sautée, sans un seul appel de modèle', async () => {
  const projet = await createProject(db, {
    ...base('Solo'),
    roster: [{ key: 'reviewer', enabled: false }],
  })
  const step = await db
    .insertInto('steps')
    .values({ project_id: projet.id, position: 1, title: 'Un pas', specs: 'des specs' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({
      step_id: step.id,
      state: 'reviewing',
      branch: 'silithid/solo-1',
      pr_number: 7,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  // Un adaptateur qui compte les sessions : une abstention qui coûterait
  // quand même un échange ne serait pas une abstention.
  let sessions = 0
  const base_ = createFakeAdapter()
  const adapter: RuntimeAdapter = {
    ...base_,
    createSession: async (o) => {
      sessions += 1
      return base_.createSession(o)
    },
  }

  const handler = createReviewingHandler({ adapter, worktreesRoot: '/tmp/silithid-inexistant' })
  const event = await handler(db, run.id)

  // `review_ok` : la PR part au déploiement. L'état n'est pas retiré de la
  // machine, il devient instantané — même arbitrage que `juge_visuel`.
  expect(event).toEqual({ type: 'review_ok' })
  expect(sessions).toBe(0)

  // Et la timeline dit pourquoi. Sans ce message, une PR passée sans revue
  // ressemble exactement à une PR revue et validée.
  const trace = await db
    .selectFrom('messages')
    .select('body')
    .where('run_id', '=', run.id)
    .execute()
  expect(trace.map((m) => m.body).join('\n')).toMatch(/Reviewer désactivé/)
})

test("le slug d'orbe est le seul identifiant accepté, et c'est bien ce que l'écran envoie", async () => {
  // Piège de lecture qui m'a fait diagnostiquer un bug inexistant :
  // `GlobeView.id` contient le SLUG, pas l'identifiant de la ligne
  // (`globes/repo.ts` sélectionne `slug` et le rend sous la clé `id`). Donc
  // `<option value={g.id}>` envoie bien un slug, et la création marche.
  //
  // Ce test fige les deux moitiés ensemble pour que le jour où `GlobeView.id`
  // redeviendra un vrai identifiant, quelque chose casse ICI plutôt qu'en
  // production sur un `globe_introuvable` incompréhensible.
  const globe = await db
    .selectFrom('globes')
    .select(['id', 'slug'])
    .where('slug', '=', globeSlug)
    .executeTakeFirstOrThrow()

  const cree = await createProject(db, {
    globeSlug: globe.slug,
    name: 'Par slug',
    repoFullName: 'desura/essai',
  })
  expect(cree.globeSlug).toBe(globe.slug)

  // L'identifiant réel de la ligne n'est PAS accepté, et c'est cohérent : rien
  // dans l'application ne le manipule.
  await expect(
    createProject(db, { globeSlug: globe.id, name: 'Par id', repoFullName: 'desura/essai' }),
  ).rejects.toThrow(/globe introuvable/)
})

test('une orbe inconnue reste un refus net', async () => {
  await expect(
    createProject(db, { globeSlug: 'orbe-qui-nexiste-pas', name: 'X', repoFullName: 'd/e' }),
  ).rejects.toThrow(/globe introuvable/)
})

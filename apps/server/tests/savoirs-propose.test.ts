import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { getInboxItem, listInbox } from '../src/inbox/repo'
import { resolveInboxItem } from '../src/inbox/resolve'
import { createBoss } from '../src/jobs/boss'
import { RUN_STEP_QUEUE } from '../src/jobs/run-step'
import { archiverSavoirApprouve, proposerSavoirs } from '../src/knowledge/propose'
import { rappeler } from '../src/knowledge/recall'
import { appendMessage, readRunMessages } from '../src/loop/bus'
import { createVerdictHandler } from '../src/loop/steps/verdict'
import type { FakeToolCall } from '../src/runtime/fake'
import { createFakeAdapter } from '../src/runtime/fake'
import { stopBoss } from './stop-boss'

// Aucun réseau, aucun token : `FakeAdapter` scripte la sortie structurée du
// garant, candidats-savoirs compris — c'est tout le point de l'arbitrage de
// cette tâche, les savoirs voyagent dans un appel qui existe déjà.

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const boss: PgBoss = createBoss(env)

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await seedRoleTemplates(db)
  await boss.start()
  await boss.createQueue(RUN_STEP_QUEUE)
})

afterAll(async () => {
  await stopBoss(boss)
  await db.destroy()
})

interface Contexte {
  globeId: string
  clientId: string | null
  projectId: string
  runId: string
}

async function createContexte(opts: { avecClient?: boolean } = {}): Promise<Contexte> {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe Savoir', slug: `globe-savoir-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const client = opts.avecClient
    ? await db
        .insertInto('clients')
        .values({ name: `Client ${randomUUID().slice(0, 6)}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    : null
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      ...(client ? { client_id: client.id } : {}),
      name: 'Projet Savoir',
      slug: `projet-savoir-${randomUUID()}`,
      repo_full_name: 'silithid/sandbox-savoir',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({
      project_id: project.id,
      position: 1,
      title: 'Step savoir',
      specs: '## Apprendre',
      max_iterations: 4,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({
      step_id: step.id,
      state: 'verdict',
      iteration: 1,
      worktree_path: `/tmp/silithid-savoir-test-${randomUUID()}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  return {
    globeId: globe.id,
    clientId: client?.id ?? null,
    projectId: project.id,
    runId: run.id,
  }
}

/** Le bus minimal que `verdict.ts` exige : cadrage, rapport reviewer, rapport juge. */
async function seedBus(runId: string): Promise<void> {
  await appendMessage(db, {
    runId,
    fromRole: 'garant',
    toRole: 'dev',
    kind: 'prompt',
    body: 'Cadrage de test pour la proposition de savoirs.',
    meta: { acceptance_criteria: ['la page répond en 200'], pages_to_judge: ['/'] },
  })
  await appendMessage(db, {
    runId,
    fromRole: 'reviewer',
    toRole: 'garant',
    kind: 'report',
    body: 'OK — tests exécutés réellement.',
    meta: { verdict: 'OK', points: [] },
  })
  await appendMessage(db, {
    runId,
    fromRole: 'judge',
    toRole: 'garant',
    kind: 'report',
    body: '1 conformité, 0 écart.',
    meta: { conformites: ['la page répond'], ecarts: [] },
  })
}

function submitVerdict(input: unknown): FakeToolCall {
  return { toolUse: { name: 'submit_verdict', input } }
}

const CANDIDAT_PHP = {
  sujet: 'version PHP · PrestaShop',
  contenu:
    'Les PrestaShop de ce client tournent en PHP 8.1 maximum · vérifier avant toute mise à jour de module.',
  cercle: 'globe' as const,
}

async function itemsSavoir(projectId: string) {
  const items = await listInbox(db, { projectId })
  return items.filter((i) => i.subtype === 'savoir')
}

// --- La proposition, dans le flux réel du verdict ---------------------------

test('un savoir proposé n avance ni ne bloque le run', async () => {
  const ctx = await createContexte()
  await seedBus(ctx.runId)

  const adapter = createFakeAdapter({
    replies: [submitVerdict({ decision: 'conforme', ecarts: [], savoirs: [CANDIDAT_PHP] })],
  })

  // L'événement rendu est exactement celui d'un verdict sans savoir : la
  // machine à états (`domain/run-state.ts`) n'a rien appris de cette tâche, et
  // c'est le contrat — un item de savoir ne traverse jamais `decide()`.
  const event = await createVerdictHandler({ adapter })(db, ctx.runId)
  expect(event).toEqual({ type: 'verdict_conforme' })

  // Un seul échange modèle pour tout le verdict, savoirs compris.
  const items = await itemsSavoir(ctx.projectId)
  expect(items).toHaveLength(1)
  expect(items[0]?.type).toBe('approval')
  expect(items[0]?.fromRole).toBe('garant')
  expect(items[0]?.status).toBe('open')
  // Ni `alert` ni `question` : rien qui réveille ou alerte.
  expect(items.every((i) => i.type === 'approval')).toBe(true)

  // Le run n'est pas passé en attente humaine : il reste où le handler l'a
  // laissé, c'est l'orchestrateur qui appliquera l'événement.
  const run = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', ctx.runId)
    .executeTakeFirstOrThrow()
  expect(run.state).toBe('verdict')

  // Source et cercle visé, comme le pack les affiche.
  expect(items[0]?.payload.savoir).toMatchObject({
    sujet: CANDIDAT_PHP.sujet,
    contenu: CANDIDAT_PHP.contenu,
    cercle: 'globe',
    cercle_id: ctx.globeId,
    source: { run_id: ctx.runId, project_id: ctx.projectId, role: 'garant' },
  })
  expect(items[0]?.title).toContain('PHP 8.1')
})

test('un run qui n apprend rien produit zéro item, jamais un item vide', async () => {
  const ctx = await createContexte()
  await seedBus(ctx.runId)

  const adapter = createFakeAdapter({
    replies: [submitVerdict({ decision: 'conforme', ecarts: [] })],
  })
  await createVerdictHandler({ adapter })(db, ctx.runId)

  expect(await itemsSavoir(ctx.projectId)).toHaveLength(0)
  // Pas de ligne de bruit dans la timeline non plus.
  const messages = await readRunMessages(db, ctx.runId)
  expect(messages.some((m) => m.body.startsWith('Savoirs proposés'))).toBe(false)
})

test('un verdict en écarts propose aussi : c est en butant qu on apprend', async () => {
  const ctx = await createContexte()
  await seedBus(ctx.runId)

  const adapter = createFakeAdapter({
    replies: [
      submitVerdict({
        decision: 'ecarts',
        ecarts: [
          { severite: 'bloquant', description: 'upload refusé', correctif: 'réduire le poids' },
        ],
        dev_prompt_correctif: 'Compresse les images avant upload.',
        savoirs: [
          {
            sujet: 'limite upload',
            contenu: 'Ce serveur refuse tout upload au-delà de 2 Mo, sans message d’erreur.',
            cercle: 'projet',
          },
        ],
      }),
    ],
  })

  const event = await createVerdictHandler({ adapter })(db, ctx.runId)
  expect(event).toEqual({ type: 'verdict_ecarts' })
  const items = await itemsSavoir(ctx.projectId)
  expect(items).toHaveLength(1)
  expect(items[0]?.payload.savoir).toMatchObject({ cercle: 'projet', cercle_id: ctx.projectId })
})

// --- Ce que le garant ne peut PAS viser -------------------------------------

test('le cercle visé est toujours celui du run : un autre globe est inatteignable', async () => {
  const autreGlobe = await db
    .insertInto('globes')
    .values({ name: 'Globe voisin', slug: `globe-voisin-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const ctx = await createContexte()

  await proposerSavoirs(db, {
    runId: ctx.runId,
    projectId: ctx.projectId,
    candidats: [CANDIDAT_PHP],
  })

  const items = await itemsSavoir(ctx.projectId)
  const savoir = items[0]?.payload.savoir as { cercle_id?: string } | undefined
  expect(savoir?.cercle_id).toBe(ctx.globeId)
  expect(savoir?.cercle_id).not.toBe(autreGlobe.id)
})

test('cercle client sur un projet sans client : candidat écarté, aucun item inventé', async () => {
  const ctx = await createContexte({ avecClient: false })

  const resultat = await proposerSavoirs(db, {
    runId: ctx.runId,
    projectId: ctx.projectId,
    candidats: [{ ...CANDIDAT_PHP, cercle: 'client' }],
  })

  expect(resultat.proposes).toHaveLength(0)
  expect(resultat.ecartes[0]?.raison).toContain('aucun client')
  expect(await itemsSavoir(ctx.projectId)).toHaveLength(0)
  // La raison est tracée : « rien proposé » ne doit pas être indistinguable de
  // « la proposition a été tue ».
  const messages = await readRunMessages(db, ctx.runId)
  expect(messages.at(-1)?.body).toContain('aucun client')
})

// --- La résolution : trois issues -------------------------------------------

test('archiver tel quel : la formulation du garant entre dans le cercle visé', async () => {
  const ctx = await createContexte()
  const { proposes } = await proposerSavoirs(db, {
    runId: ctx.runId,
    projectId: ctx.projectId,
    candidats: [CANDIDAT_PHP],
  })
  const itemId = proposes[0]?.id ?? ''

  const { item, runResumed } = await resolveInboxItem(db, boss, itemId, { approved: true })
  // Silencieux : le run n'était pas bloqué, il ne repart pas.
  expect(runResumed).toBe(false)

  const savoir = await archiverSavoirApprouve(db, item)
  expect(savoir?.contenu).toBe(CANDIDAT_PHP.contenu)
  expect(savoir?.cercle).toBe('globe')
  expect(savoir?.version).toBe(1)

  const rappeles = await rappeler(db, { globeId: ctx.globeId })
  expect(rappeles.map((s) => s.contenu)).toContain(CANDIDAT_PHP.contenu)
})

test('corriger puis archiver : la formulation corrigée fait foi, jamais celle de l agent', async () => {
  const ctx = await createContexte()
  const { proposes } = await proposerSavoirs(db, {
    runId: ctx.runId,
    projectId: ctx.projectId,
    candidats: [CANDIDAT_PHP],
  })

  const corrige = 'PHP 8.1 max sur les PrestaShop de ce client, sauf Le Koin qui est en 8.2.'
  const { item } = await resolveInboxItem(db, boss, proposes[0]?.id ?? '', {
    approved: true,
    text: corrige,
  })

  const savoir = await archiverSavoirApprouve(db, item)
  expect(savoir?.contenu).toBe(corrige)
  expect(savoir?.contenu).not.toBe(CANDIDAT_PHP.contenu)

  // C'est bien la formulation corrigée qui sera rappelée aux agents.
  const rappeles = await rappeler(db, { globeId: ctx.globeId })
  expect(rappeles.map((s) => s.contenu)).toEqual([corrige])
})

test('refuser : rien n est archivé, et le même sujet ne revient pas au run suivant', async () => {
  const ctx = await createContexte()
  const { proposes } = await proposerSavoirs(db, {
    runId: ctx.runId,
    projectId: ctx.projectId,
    candidats: [CANDIDAT_PHP],
  })

  const { item } = await resolveInboxItem(db, boss, proposes[0]?.id ?? '', { approved: false })
  expect(await archiverSavoirApprouve(db, item)).toBeNull()
  expect(await rappeler(db, { globeId: ctx.globeId })).toHaveLength(0)

  // Run suivant, même trouvaille : l'inbox ne se remplit pas de ce qui a déjà
  // été refusé.
  const suivant = await proposerSavoirs(db, {
    runId: ctx.runId,
    projectId: ctx.projectId,
    candidats: [CANDIDAT_PHP],
  })
  expect(suivant.proposes).toHaveLength(0)
  expect(suivant.ecartes[0]?.raison).toContain('refusé')

  // Et encore le run d'après : le refus n'empêche pas que la première
  // répétition, il tient tant que le sujet est le même.
  const encore = await proposerSavoirs(db, {
    runId: ctx.runId,
    projectId: ctx.projectId,
    candidats: [{ ...CANDIDAT_PHP, contenu: `${CANDIDAT_PHP.contenu} Reformulé autrement.` }],
  })
  expect(encore.proposes).toHaveLength(0)

  expect(await itemsSavoir(ctx.projectId)).toHaveLength(1)
})

test('un refus dans un cercle ne fait pas taire le même sujet dans un autre', async () => {
  const ctx = await createContexte()
  const { proposes } = await proposerSavoirs(db, {
    runId: ctx.runId,
    projectId: ctx.projectId,
    candidats: [CANDIDAT_PHP],
  })
  await resolveInboxItem(db, boss, proposes[0]?.id ?? '', { approved: false })

  // Même sujet, cercle plus étroit : c'est une autre décision, elle mérite
  // d'être posée.
  const projet = await proposerSavoirs(db, {
    runId: ctx.runId,
    projectId: ctx.projectId,
    candidats: [{ ...CANDIDAT_PHP, cercle: 'projet' }],
  })
  expect(projet.proposes).toHaveLength(1)
})

test('une proposition déjà ouverte n est pas doublée par une itération suivante', async () => {
  const ctx = await createContexte()
  await proposerSavoirs(db, {
    runId: ctx.runId,
    projectId: ctx.projectId,
    candidats: [CANDIDAT_PHP],
  })
  const second = await proposerSavoirs(db, {
    runId: ctx.runId,
    projectId: ctx.projectId,
    candidats: [CANDIDAT_PHP],
  })

  expect(second.proposes).toHaveLength(0)
  expect(second.ecartes[0]?.raison).toContain('attend déjà')
  expect(await itemsSavoir(ctx.projectId)).toHaveLength(1)
})

test('un item de savoir ouvert ne bloque pas la résolution du run qui l a produit', async () => {
  const ctx = await createContexte()
  const { proposes } = await proposerSavoirs(db, {
    runId: ctx.runId,
    projectId: ctx.projectId,
    candidats: [CANDIDAT_PHP],
  })

  // `blocked_since` vaut `created_at` comme pour tout item, mais le run reste
  // en `verdict` : rien dans `runs` n'a bougé.
  const item = await getInboxItem(db, proposes[0]?.id ?? '')
  expect(item?.runId).toBe(ctx.runId)
  const run = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', ctx.runId)
    .executeTakeFirstOrThrow()
  expect(run.state).toBe('verdict')
})

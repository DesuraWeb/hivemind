import { randomUUID } from 'node:crypto'
import type { AutonomyMode } from '@silithid/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import {
  PROD_INBOX_SUBTYPE,
  type ProdChangedFile,
  type ProdRollback,
  type ProdStaging,
  buildRollback,
  parseChangedFiles,
  resolveStaging,
} from '../src/deploy/prod-gate'
import { databaseUrl, loadEnv } from '../src/env'
import { appendMessage } from '../src/loop/bus'
import { applyEvent } from '../src/loop/orchestrator'
import { createVerdictHandler } from '../src/loop/steps/verdict'
import type { FakeToolCall } from '../src/runtime/fake'
import { createFakeAdapter } from '../src/runtime/fake'

/**
 * Le gate de mise en prod (Phase 5, Task 4). Aucun token : `FakeAdapter`
 * scripte la sortie structurée du garant, et le gate lui-même n'appelle aucun
 * modèle. Les tests passent par le HANDLER RÉEL (`createVerdictHandler`), pas
 * par `runProdGate` seul : ce qui compte n'est pas que le gate SACHE lever un
 * item, c'est qu'il le lève sur le chemin qu'un run emprunte vraiment.
 */

const db = createDb(createPool(databaseUrl(loadEnv())))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await seedRoleTemplates(db)
})
afterAll(async () => {
  await db.destroy()
})

interface Fixture {
  runId: string
  projectId: string
}

async function createFixtureRun(
  opts: {
    stepAutonomy?: AutonomyMode | null
    projectAutonomy?: AutonomyMode
    stagingUrl?: string | null
    iteration?: number
    maxIterations?: number
    stepPosition?: number
    /** Steps frères du projet, pour que « Step 3/7 » du pack DA ait un dénominateur réel. */
    siblingSteps?: number
  } = {},
): Promise<Fixture> {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe Prod', slug: `globe-prod-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Le Koin',
      slug: `koin-${randomUUID()}`,
      repo_full_name: 'silithid/koin',
      staging_url: opts.stagingUrl ?? null,
      ...(opts.projectAutonomy ? { autonomy_default: opts.projectAutonomy } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({
      project_id: project.id,
      position: opts.stepPosition ?? 3,
      title: 'Fiche établissement',
      specs: '## Fiche',
      autonomy: opts.stepAutonomy ?? null,
      max_iterations: opts.maxIterations ?? 4,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  for (let i = 0; i < (opts.siblingSteps ?? 0); i++) {
    await db
      .insertInto('steps')
      .values({
        project_id: project.id,
        position: 100 + i,
        title: `Autre step ${i}`,
        specs: '## Autre',
      })
      .execute()
  }
  const run = await db
    .insertInto('runs')
    .values({
      step_id: step.id,
      state: 'verdict',
      iteration: opts.iteration ?? 2,
      worktree_path: `/tmp/silithid-prod-test-${randomUUID()}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { runId: run.id, projectId: project.id }
}

/** Les trois passations que `verdict.ts` exige, plus celles que le gate exploite. */
async function seedTimeline(
  runId: string,
  opts: {
    changedFiles?: unknown
    baseCommit?: string | null
    withPr?: boolean
    deployUrl?: string | null
    deployTarget?: string
  } = {},
): Promise<void> {
  await appendMessage(db, {
    runId,
    fromRole: 'garant',
    toRole: 'dev',
    kind: 'prompt',
    body: 'Cadrage de test.',
    meta: { acceptance_criteria: ['la fiche affiche les horaires'], pages_to_judge: ['/'] },
  })

  const withPr = opts.withPr ?? true
  await appendMessage(db, {
    runId,
    fromRole: 'dev',
    toRole: 'garant',
    kind: 'report',
    body: 'Fiche implémentée.',
    meta: {
      ...(withPr ? { pr_number: 142, pr_url: 'https://github.com/silithid/koin/pull/142' } : {}),
      branch: `run/${runId}`,
      changed_files: opts.changedFiles ?? [
        { path: 'src/fiche.php', status: 'modified', additions: 2340, deletions: 118 },
      ],
      base_ref: 'main',
      base_commit: opts.baseCommit === undefined ? 'abc1234def' : opts.baseCommit,
    },
  })

  if (opts.deployUrl !== null) {
    await appendMessage(db, {
      runId,
      fromRole: 'system',
      toRole: 'system',
      kind: 'info',
      body: 'Aperçu servi.',
      meta: {
        url: opts.deployUrl ?? 'http://127.0.0.1:52341/',
        target: opts.deployTarget ?? 'local-preview',
        pages: ['/'],
        artifactIds: [],
      },
    })
  }

  await appendMessage(db, {
    runId,
    fromRole: 'reviewer',
    toRole: 'garant',
    kind: 'report',
    body: 'OK.',
    meta: { verdict: 'OK' },
  })
  await appendMessage(db, {
    runId,
    fromRole: 'judge',
    toRole: 'garant',
    kind: 'report',
    body: '1 conformité, 0 écart.',
    meta: { conformites: ['horaires visibles'], ecarts: [] },
  })
}

function submitVerdict(input: unknown): FakeToolCall {
  return { toolUse: { name: 'submit_verdict', input } }
}

function conformeAdapter(ecarts: unknown[] = []) {
  return createFakeAdapter({ replies: [submitVerdict({ decision: 'conforme', ecarts })] })
}

async function prodItems(runId: string) {
  return db
    .selectFrom('inbox_items')
    .selectAll()
    .where('run_id', '=', runId)
    .where('type', '=', 'approval')
    .where('subtype', '=', PROD_INBOX_SUBTYPE)
    .execute()
}

interface ProdPayload {
  cause: string
  ctx: string
  autonomy: AutonomyMode
  prod: {
    step: string
    iters: string
    verdict: string
    pr: string
    changes: string[]
    staging: ProdStaging
    rollback: ProdRollback
    warnings: string[]
    on_approve: string
  }
  pr_number: number | null
  pr_url: string | null
}

// ---------------------------------------------------------------------------
// LE test de la tâche : le mode de boucle n'exempte jamais de ce gate.
// ---------------------------------------------------------------------------

test('un step en full-auto lève quand même le gate prod, et le run se termine sans attendre', async () => {
  const { runId } = await createFixtureRun({ stepAutonomy: 'auto' })
  await seedTimeline(runId)

  const event = await createVerdictHandler({ adapter: conformeAdapter() })(db, runId)
  expect(event).toEqual({ type: 'verdict_conforme' })

  // L'item existe AVANT même que la machine à états ne voie l'événement :
  // le gate ne dépend d'aucune transition.
  const raised = await prodItems(runId)
  expect(raised).toHaveLength(1)
  expect(raised[0]?.status).toBe('open')

  // Et il reste là après que `decide()` a fait ce que `auto` prescrit :
  // terminer le run sans passer par un humain. C'est la preuve que le mode
  // n'exempte pas du gate — le run est `done`, l'approbation de prod est
  // ouverte, et rien n'a été déployé.
  const { state } = await applyEvent(db, runId, event)
  expect(state).toBe('done')

  const after = await db.selectFrom('inbox_items').selectAll().where('run_id', '=', runId).execute()
  expect(after).toHaveLength(1)
  expect(after[0]?.subtype).toBe(PROD_INBOX_SUBTYPE)
  // Aucun `approval:step_end` en mode auto : le seul item est celui du gate prod.
  expect(after.every((i) => i.subtype !== 'step_end')).toBe(true)

  const payload = after[0]?.payload as unknown as ProdPayload
  expect(payload.autonomy).toBe('auto')
  expect(payload.ctx).toContain('auto')
})

test("un step qui hérite d'un projet en auto lève le gate tout autant", async () => {
  const { runId } = await createFixtureRun({ stepAutonomy: null, projectAutonomy: 'auto' })
  await seedTimeline(runId)

  await createVerdictHandler({ adapter: conformeAdapter() })(db, runId)

  const raised = await prodItems(runId)
  expect(raised).toHaveLength(1)
  expect((raised[0]?.payload as unknown as ProdPayload).autonomy).toBe('auto')
})

test('en mode gated, le gate prod coexiste avec l’approbation de fin de step', async () => {
  const { runId } = await createFixtureRun({ stepAutonomy: 'gated' })
  await seedTimeline(runId)

  const event = await createVerdictHandler({ adapter: conformeAdapter() })(db, runId)
  const { state } = await applyEvent(db, runId, event)
  expect(state).toBe('awaiting_human')

  const items = await db.selectFrom('inbox_items').selectAll().where('run_id', '=', runId).execute()
  const subtypes = items.map((i) => i.subtype).sort()
  expect(subtypes).toEqual(['prod', 'step_end'])
})

// ---------------------------------------------------------------------------
// Verdict `ecarts` : rien à promouvoir, donc aucun item de prod.
// ---------------------------------------------------------------------------

test('un verdict ecarts ne lève aucun gate prod', async () => {
  const { runId } = await createFixtureRun({ stepAutonomy: 'auto', iteration: 1 })
  await seedTimeline(runId)

  const adapter = createFakeAdapter({
    replies: [
      submitVerdict({
        decision: 'ecarts',
        ecarts: [
          { severite: 'bloquant', description: 'horaires absents', correctif: 'les afficher' },
        ],
        dev_prompt_correctif: 'Affiche les horaires.',
      }),
    ],
  })
  const event = await createVerdictHandler({ adapter })(db, runId)
  expect(event).toEqual({ type: 'verdict_ecarts' })

  expect(await prodItems(runId)).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// La forme de l'item : décider sans ouvrir un terminal.
// ---------------------------------------------------------------------------

test("l'item porte la forme du pack DA et de quoi décider sans terminal", async () => {
  const { runId } = await createFixtureRun({
    stepAutonomy: 'gated',
    stepPosition: 3,
    siblingSteps: 6,
  })
  await seedTimeline(runId)

  await createVerdictHandler({
    adapter: conformeAdapter([
      { severite: 'mineur', description: 'espacement de 2px', correctif: 'aucun' },
    ]),
  })(db, runId)

  const [item] = await prodItems(runId)
  expect(item?.type).toBe('approval')
  expect(item?.subtype).toBe('prod')
  expect(item?.from_role).toBe('garant')
  expect(item?.title).toBe('Mise en prod · Le Koin, step 3')
  // Séparateur « · », jamais de tiret cadratin dans une chaîne d'UI.
  expect(item?.title).not.toContain('—')

  const payload = item?.payload as unknown as ProdPayload
  // Les quatre clés du panneau prod du pack DA.
  expect(payload.prod.step).toBe('Step 3/7 · Fiche établissement')
  expect(payload.prod.iters).toContain('2 itération(s) sur 4')
  expect(payload.prod.verdict).toContain('conforme')
  expect(payload.prod.pr).toBe('PR #142 · +2340 −118 · 1 fichier(s)')
  // Ce qui change, nommément.
  expect(payload.prod.changes.join('\n')).toContain('src/fiche.php')
  expect(payload.pr_url).toBe('https://github.com/silithid/koin/pull/142')
  // Ce que valider fait réellement aujourd'hui : rien.
  expect(payload.prod.on_approve).toContain('ne déclenche aucun déploiement')
})

// ---------------------------------------------------------------------------
// L'URL de staging : vérifiée, ou dite non vérifiée. Jamais présentée à tort.
// ---------------------------------------------------------------------------

test("l'aperçu local n'est jamais présenté comme une URL de staging vérifiée", async () => {
  const { runId } = await createFixtureRun({ stagingUrl: 'https://staging.koin.fr' })
  await seedTimeline(runId, { deployUrl: 'http://127.0.0.1:52341/' })

  await createVerdictHandler({ adapter: conformeAdapter() })(db, runId)

  const [item] = await prodItems(runId)
  const staging = (item?.payload as unknown as ProdPayload).prod.staging
  expect(staging.verified).toBe(false)
  if (staging.verified === false) {
    expect(staging.reason).toContain('aperçu local')
    // L'URL déclarée dans le projet est reportée, mais séparément : elle n'a
    // pas été vérifiée par ce run.
    expect(staging.declaredUrl).toBe('https://staging.koin.fr')
  }
})

test('une URL de staging réelle capturée par le juge est marquée vérifiée', async () => {
  const { runId } = await createFixtureRun()
  await seedTimeline(runId, {
    deployUrl: 'https://staging.koin.fr/fiche',
    deployTarget: 'rsync',
  })

  await createVerdictHandler({ adapter: conformeAdapter() })(db, runId)

  const [item] = await prodItems(runId)
  const staging = (item?.payload as unknown as ProdPayload).prod.staging
  expect(staging.verified).toBe(true)
  if (staging.verified === true) {
    expect(staging.url).toBe('https://staging.koin.fr/fiche')
    expect(staging.targetKind).toBe('rsync')
  }
})

test('aucun déploiement dans la timeline : le gate le dit au lieu de rester muet', async () => {
  const { runId } = await createFixtureRun()
  await seedTimeline(runId, { deployUrl: null })

  await createVerdictHandler({ adapter: conformeAdapter() })(db, runId)

  const [item] = await prodItems(runId)
  const staging = (item?.payload as unknown as ProdPayload).prod.staging
  expect(staging.verified).toBe(false)
  if (staging.verified === false) expect(staging.reason).toContain('Aucune trace de déploiement')
})

// ---------------------------------------------------------------------------
// Le rollback : une information réelle, ou l'aveu qu'on ne l'a pas.
// ---------------------------------------------------------------------------

test('rollback déterminé : la PR à annuler et le commit de retour, tous deux nommés', async () => {
  const { runId } = await createFixtureRun()
  await seedTimeline(runId)

  await createVerdictHandler({ adapter: conformeAdapter() })(db, runId)

  const [item] = await prodItems(runId)
  const rollback = (item?.payload as unknown as ProdPayload).prod.rollback
  expect(rollback.determined).toBe(true)
  if (rollback.determined === true) {
    expect(rollback.base).toEqual({ ref: 'main', commit: 'abc1234def' })
    expect(rollback.steps.join('\n')).toContain('#142')
    expect(rollback.steps.join('\n')).toContain('abc1234def')
  }
})

test('une migration dans le step rend le rollback indéterminable, et l’item le dit', async () => {
  const { runId } = await createFixtureRun()
  await seedTimeline(runId, {
    changedFiles: [
      { path: 'src/fiche.php', status: 'modified', additions: 10, deletions: 2 },
      { path: 'database/migrations/2026_08_13_ajout_horaires.php', status: 'added' },
    ],
  })

  await createVerdictHandler({ adapter: conformeAdapter() })(db, runId)

  const [item] = await prodItems(runId)
  const rollback = (item?.payload as unknown as ProdPayload).prod.rollback
  expect(rollback.determined).toBe(false)
  if (rollback.determined === false) {
    expect(rollback.blockers.join('\n')).toContain('migration')
    expect(rollback.blockers.join('\n')).toContain('2026_08_13_ajout_horaires.php')
    // Ce qui reste vrai côté code est tout de même donné : « je ne sais pas »
    // ne doit pas effacer ce qu'on sait.
    expect(rollback.steps.join('\n')).toContain('#142')
  }
})

test('base inconnue : le gate refuse d’affirmer un commit de retour', async () => {
  const { runId } = await createFixtureRun()
  await seedTimeline(runId, { baseCommit: null })

  await createVerdictHandler({ adapter: conformeAdapter() })(db, runId)

  const [item] = await prodItems(runId)
  const rollback = (item?.payload as unknown as ProdPayload).prod.rollback
  expect(rollback.determined).toBe(false)
  if (rollback.determined === false) {
    expect(rollback.blockers.join('\n')).toContain("La base de ce step n'a pas été enregistrée")
  }
})

// ---------------------------------------------------------------------------
// Règle dure : aucune écriture dans la configuration serveur du client.
// ---------------------------------------------------------------------------

test('un .htaccess dans le step déclenche un avertissement explicite', async () => {
  const { runId } = await createFixtureRun()
  await seedTimeline(runId, {
    changedFiles: [
      { path: 'public/.htaccess', status: 'modified', additions: 3, deletions: 0 },
      { path: 'src/fiche.php', status: 'modified', additions: 4, deletions: 1 },
    ],
  })

  await createVerdictHandler({ adapter: conformeAdapter() })(db, runId)

  const [item] = await prodItems(runId)
  const warnings = (item?.payload as unknown as ProdPayload).prod.warnings
  expect(warnings.join('\n')).toContain('public/.htaccess')
  expect(warnings.join('\n')).toContain('ne les déploie jamais')
})

// ---------------------------------------------------------------------------
// Dédoublonnage : un second passage par `verdict` ne crée pas un second item.
// ---------------------------------------------------------------------------

test('un second verdict conforme sur le même run ne rouvre pas un second item', async () => {
  const { runId } = await createFixtureRun({ stepAutonomy: 'gated' })
  await seedTimeline(runId)

  await createVerdictHandler({ adapter: conformeAdapter() })(db, runId)
  await createVerdictHandler({ adapter: conformeAdapter() })(db, runId)

  expect(await prodItems(runId)).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// Fonctions pures : les cas que le handler ne peut pas produire facilement.
// ---------------------------------------------------------------------------

test('resolveStaging traite localhost, ::1 et 0.0.0.0 comme non vérifiables', () => {
  for (const url of [
    'http://localhost:3000/',
    'http://127.0.0.1:8080/page',
    'http://[::1]:5000',
    'http://0.0.0.0:9000/',
  ]) {
    const staging = resolveStaging({ url, targetKind: 'local-preview', pages: 1 }, null)
    expect(staging.verified).toBe(false)
  }
})

test('parseChangedFiles ignore ce qui n’a pas la forme attendue', () => {
  const parsed = parseChangedFiles([
    { path: 'a.php', status: 'modified', additions: 1, deletions: 2 },
    { status: 'modified' },
    'a.php',
    null,
    { path: 'b.php' },
  ])
  expect(parsed).toEqual([
    { path: 'a.php', status: 'modified', additions: 1, deletions: 2 },
    { path: 'b.php', status: null, additions: null, deletions: null },
  ] satisfies ProdChangedFile[])
  expect(parseChangedFiles(undefined)).toEqual([])
})

test('buildRollback traite un .sql nu comme une migration', () => {
  const rollback = buildRollback({
    base: { ref: 'main', commit: 'deadbee' },
    pr: null,
    changedFiles: [{ path: 'db/schema-2026.sql', status: 'added', additions: 12, deletions: 0 }],
  })
  expect(rollback.determined).toBe(false)
})

test('buildRollback sans PR reste déterminé : le commit de base suffit à revenir', () => {
  const rollback = buildRollback({
    base: { ref: 'main', commit: 'deadbee' },
    pr: null,
    changedFiles: [{ path: 'src/a.php', status: 'modified', additions: 1, deletions: 1 }],
  })
  expect(rollback.determined).toBe(true)
  expect(rollback.steps.join('\n')).toContain('deadbee')
})

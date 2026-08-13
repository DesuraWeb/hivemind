import { randomUUID } from 'node:crypto'
import type { RunState } from '@silithid/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { createInboxItem } from '../src/inbox/repo'

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const app = await buildApp({ db })

let cookie: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
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

interface RunFixture {
  state: RunState
  stepPosition: number
  iteration?: number
  maxIterations?: number
  resumeState?: RunState | null
  costTokens?: number
  startedAt?: Date
}

interface ProjectFixtureOpts {
  slug: string
  name?: string
  clientName?: string
  tint?: string
  synth?: string
  staging?: string
  stepsCount?: number
  run?: RunFixture
  /** Runs additionnels (pour tester le cumul de `conso` sur plusieurs runs). */
  extraRuns?: RunFixture[]
}

async function createProjectFixture(opts: ProjectFixtureOpts): Promise<string> {
  const globe = await db.selectFrom('globes').select('id').executeTakeFirstOrThrow()

  let clientId: string | undefined
  if (opts.clientName) {
    const c = await db
      .insertInto('clients')
      .values({ name: opts.clientName })
      .returning('id')
      .executeTakeFirstOrThrow()
    clientId = c.id
  }

  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      client_id: clientId ?? null,
      name: opts.name ?? opts.slug,
      slug: opts.slug,
      repo_full_name: 'desura/x',
      tint: opts.tint ?? null,
      synth: opts.synth ?? null,
      staging_url: opts.staging ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const stepsCount = opts.stepsCount ?? 3
  const stepIds: string[] = []
  for (let i = 1; i <= stepsCount; i++) {
    const s = await db
      .insertInto('steps')
      .values({
        project_id: project.id,
        position: i,
        title: `Step ${i}`,
        specs: '## specs',
        max_iterations: opts.run?.maxIterations ?? 4,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    stepIds.push(s.id)
  }

  async function insertRun(run: RunFixture): Promise<void> {
    const stepId = stepIds[run.stepPosition - 1]
    if (!stepId) throw new Error(`fixture invalide : pas de step à la position ${run.stepPosition}`)
    const inserted = await db
      .insertInto('runs')
      .values({
        step_id: stepId,
        state: run.state,
        iteration: run.iteration ?? 1,
        resume_state: run.resumeState ?? null,
        cost_tokens: String(run.costTokens ?? 0),
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    // `started_at` (Generated<Timestamp>, cf. db/types.ts) refuse un `Date`
    // direct dans `.values()`/`.set()` typés — bug de composition de types
    // pré-existant (`Generated<ColumnType<...>>` n'unwrap pas le insert type
    // imbriqué). Une requête `sql` brute contourne le typage strict sans y
    // toucher, pour ce seul besoin de test (backdater un run pour `duree`).
    if (run.startedAt) {
      await sql`update runs set started_at = ${run.startedAt} where id = ${inserted.id}`.execute(db)
    }
  }

  if (opts.run) await insertRun(opts.run)
  for (const extra of opts.extraRuns ?? []) await insertRun(extra)

  return project.id
}

function get(url: string) {
  return app.inject({ method: 'GET', url, cookies: { hm_session: cookie } })
}

// --- Authentification ---

test('GET /api/projects sans cookie renvoie 401', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401)
})

test('GET /api/projects/:id sans cookie renvoie 401', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/projects/x' })).statusCode).toBe(401)
})

test('GET /api/projects/:id/steps sans cookie renvoie 401', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/projects/x/steps' })).statusCode).toBe(401)
})

test('GET /api/projects/:id/runs sans cookie renvoie 401', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/projects/x/runs' })).statusCode).toBe(401)
})

// --- Forme exacte comparée champ à champ à PROJECTS[0] (koin) de data.js ---

test('GET /api/projects/:id : forme complète, comparée champ à champ à koin (data.js)', async () => {
  const startedAt = new Date(Date.now() - 14 * 60_000)
  const slug = `koin-${randomUUID()}`
  await createProjectFixture({
    slug,
    name: 'Le Koin',
    clientName: 'Annuaire local',
    tint: '#7FD9CF',
    synth: 'Le dev itère sereinement · prod du step 3 à valider.',
    staging: 'stg.lekoin.fr',
    stepsCount: 7,
    run: {
      state: 'coding',
      stepPosition: 4,
      iteration: 2,
      maxIterations: 4,
      costTokens: 14_200,
      startedAt,
    },
  })
  const projectId = await db
    .selectFrom('projects')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirstOrThrow()
  await createInboxItem(db, { type: 'approval', title: 'Mise en prod', projectId: projectId.id })

  const res = await get(`/api/projects/${slug}`)
  expect(res.statusCode).toBe(200)
  const body = res.json()

  // data.js PROJECTS[0] :
  // { id:"koin", name:"Le Koin", client:"Annuaire local", stack:"Laravel",
  //   step:[4,7], loop:"run", role:"dev", iteration:[2,4], duree:"14 min",
  //   tint:"#7FD9CF", nodes:520, pending:[{type:"approval",n:1}],
  //   conso:"14,2 k tokens · 2,10 €", synth:"...", staging:"stg.lekoin.fr",
  //   line:"step 4/7 · dev · itér. 2/4 · 14 min" }
  expect(body.id).toBe(slug)
  expect(body.name).toBe('Le Koin')
  expect(body.client).toBe('Annuaire local')
  // `stack` et `nodes` : aucune colonne ne les porte (gap hors des 4 repérés
  // par le plan Phase 3) — cf. rapport Task 4.
  expect(body.stack).toBeNull()
  expect(body.nodes).toBeNull()
  expect(body.step).toEqual([4, 7])
  expect(body.loop).toBe('run')
  expect(body.role).toBe('dev')
  expect(body.iteration).toEqual([2, 4])
  expect(body.duree).toBe('14 min')
  expect(body.tint).toBe('#7FD9CF')
  expect(body.pending).toEqual([{ type: 'approval', n: 1 }])
  // Taux de conversion : settings absent en base de test ⇒ repli à 15
  // (DEFAULT_EUR_PER_MTOK, même valeur que seed.ts). 14200 tokens à 15 €/Mtok.
  expect(body.conso).toBe('14,2 k tokens · 0,21 €')
  expect(body.synth).toBe('Le dev itère sereinement · prod du step 3 à valider.')
  expect(body.staging).toBe('stg.lekoin.fr')
  expect(body.line).toBe('step 4/7 · dev · itér. 2/4 · 14 min')
  expect(Object.keys(body).sort()).toEqual(
    [
      'id',
      'name',
      'client',
      'stack',
      'step',
      'loop',
      'role',
      'iteration',
      'duree',
      'tint',
      'nodes',
      'pending',
      'conso',
      'synth',
      'staging',
      'line',
      // Ajouté pour l'écran « intérieur de globe » : il filtre là-dessus.
      'globe',
    ].sort(),
  )
})

// --- Une valeur de `loop` par test, via la vraie route (pas seulement la fonction pure) ---

test('loop="run" pour un run dans un état actif (coding)', async () => {
  const slug = `loop-run-${randomUUID()}`
  await createProjectFixture({ slug, run: { state: 'coding', stepPosition: 1 } })
  const body = (await get(`/api/projects/${slug}`)).json()
  expect(body.loop).toBe('run')
  expect(body.role).toBe('dev')
})

test('loop="wait" pour un run awaiting_human', async () => {
  const slug = `loop-wait-${randomUUID()}`
  await createProjectFixture({
    slug,
    run: { state: 'awaiting_human', stepPosition: 1, resumeState: 'framing' },
  })
  const body = (await get(`/api/projects/${slug}`)).json()
  expect(body.loop).toBe('wait')
  expect(body.role).toBe('garant')
  expect(body.duree).toBe('·')
  expect(body.iteration).toBeNull()
})

test('loop="fail" pour un run failed', async () => {
  const slug = `loop-fail-${randomUUID()}`
  await createProjectFixture({
    slug,
    run: { state: 'failed', stepPosition: 1, iteration: 4, maxIterations: 4 },
  })
  const body = (await get(`/api/projects/${slug}`)).json()
  expect(body.loop).toBe('fail')
  // itération toujours affichée en échec (data.js : calanques)
  expect(body.iteration).toEqual([4, 4])
  expect(body.role).toBeNull()
})

test('loop="done" pour un run done', async () => {
  const slug = `loop-done-${randomUUID()}`
  await createProjectFixture({ slug, stepsCount: 3, run: { state: 'done', stepPosition: 3 } })
  const body = (await get(`/api/projects/${slug}`)).json()
  expect(body.loop).toBe('done')
  expect(body.role).toBeNull()
  expect(body.duree).toBe('·')
  expect(body.line).toBe('step 3/3 · terminé')
})

test('loop="pause" pour un run paused_budget', async () => {
  const slug = `loop-pause-${randomUUID()}`
  await createProjectFixture({
    slug,
    run: { state: 'paused_budget', stepPosition: 1, resumeState: 'coding' },
  })
  const body = (await get(`/api/projects/${slug}`)).json()
  expect(body.loop).toBe('pause')
  expect(body.role).toBeNull()
})

test('loop="demarrage" pour un projet SANS AUCUN run', async () => {
  const slug = `loop-no-run-${randomUUID()}`
  await createProjectFixture({ slug, stepsCount: 5 })
  const body = (await get(`/api/projects/${slug}`)).json()
  expect(body.loop).toBe('demarrage')
  expect(body.role).toBeNull()
  expect(body.step).toEqual([1, 5])
  expect(body.iteration).toBeNull()
  expect(body.conso).toBe('0 token')
})

// --- Liste, agrégation, cumul de conso ---

test('GET /api/projects rend un tableau contenant les projets créés', async () => {
  const slug = `list-${randomUUID()}`
  await createProjectFixture({ slug })
  const res = await get('/api/projects')
  expect(res.statusCode).toBe(200)
  const body = res.json() as Array<{ id: string }>
  expect(body.some((p) => p.id === slug)).toBe(true)
})

test('conso cumule le coût de PLUSIEURS runs du même projet', async () => {
  const slug = `conso-cumul-${randomUUID()}`
  await createProjectFixture({
    slug,
    stepsCount: 2,
    run: { state: 'done', stepPosition: 1, costTokens: 1000 },
    extraRuns: [{ state: 'done', stepPosition: 2, costTokens: 2000 }],
  })
  const body = (await get(`/api/projects/${slug}`)).json()
  // (1000 + 2000) tokens = 3,0 k tokens ; 3000/1e6*15 = 0,045 € → "0,04" en
  // virgule flottante IEEE754 (0.045 est représenté légèrement en-dessous).
  expect(body.conso).toBe('3,0 k tokens · 0,04 €')
})

// --- 404 sur identifiant inconnu ---

test('GET /api/projects/:id sur un slug inconnu renvoie 404', async () => {
  expect((await get('/api/projects/slug-totalement-inconnu')).statusCode).toBe(404)
})

test('GET /api/projects/:id/steps sur un slug inconnu renvoie 404', async () => {
  expect((await get('/api/projects/slug-totalement-inconnu/steps')).statusCode).toBe(404)
})

test('GET /api/projects/:id/runs sur un slug inconnu renvoie 404', async () => {
  expect((await get('/api/projects/slug-totalement-inconnu/runs')).statusCode).toBe(404)
})

// --- /:id/steps et /:id/runs ---

test('GET /api/projects/:id/steps rend les steps triés par position', async () => {
  const slug = `steps-${randomUUID()}`
  await createProjectFixture({ slug, stepsCount: 3 })
  const body = (await get(`/api/projects/${slug}/steps`)).json() as Array<{
    position: number
    title: string
  }>
  expect(body.map((s) => s.position)).toEqual([1, 2, 3])
  expect(body[0]).toMatchObject({ position: 1, title: 'Step 1', status: 'pending' })
})

test('GET /api/projects/:id/runs rend les runs sans exposer worktree_path (chemin serveur)', async () => {
  const slug = `runs-${randomUUID()}`
  await createProjectFixture({ slug, run: { state: 'coding', stepPosition: 1 } })
  const projectId = await db
    .selectFrom('projects')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirstOrThrow()
  const run = await db
    .selectFrom('runs')
    .innerJoin('steps', 'steps.id', 'runs.step_id')
    .select('runs.id as runId')
    .where('steps.project_id', '=', projectId.id)
    .executeTakeFirstOrThrow()
  await db
    .updateTable('runs')
    .set({ worktree_path: '/Users/florian/secret/worktree-path' })
    .where('id', '=', run.runId)
    .execute()

  const res = await get(`/api/projects/${slug}/runs`)
  expect(res.statusCode).toBe(200)
  const body = res.json() as Array<Record<string, unknown>>
  expect(body).toHaveLength(1)
  expect(body[0]?.state).toBe('coding')
  expect(JSON.stringify(body)).not.toContain('worktree')
  expect(JSON.stringify(body)).not.toContain('/Users/florian')
})

test('GET /api/projects?globe=<slug> ne rend que les projets de ce globe', async () => {
  const dedans = `dedans-${randomUUID()}`
  const dehors = `dehors-${randomUUID()}`
  await createProjectFixture({ slug: dehors })

  // `createProjectFixture` range tout dans le premier globe : sans un second
  // globe créé ici, le filtre passerait sans rien prouver.
  const autreGlobe = await db
    .insertInto('globes')
    .values({ name: 'Globe filtre', slug: `globe-filtre-${randomUUID()}` })
    .returning(['id', 'slug'])
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('projects')
    .values({
      globe_id: autreGlobe.id,
      name: dedans,
      slug: dedans,
      repo_full_name: 'desura/x',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await db
    .insertInto('steps')
    .values({ project_id: step.id, position: 1, title: 'Step 1', specs: '## specs' })
    .execute()

  expect((await get(`/api/projects/${dedans}`)).json().globe).toBe(autreGlobe.slug)

  const filtres = (await get(`/api/projects?globe=${autreGlobe.slug}`)).json()
  expect(filtres.map((p: { id: string }) => p.id)).toEqual([dedans])

  // Un slug inconnu rend une liste vide, pas une erreur : c'est la page qui
  // decide quoi afficher pour un globe sans projet.
  expect((await get('/api/projects?globe=globe-qui-nexiste-pas')).json()).toEqual([])

  // Sans filtre, les deux sont la : le filtre ne doit pas devenir implicite.
  const tous = (await get('/api/projects')).json().map((p: { id: string }) => p.id)
  expect(tous).toEqual(expect.arrayContaining([dedans, dehors]))
})

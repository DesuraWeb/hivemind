import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { createBoss } from '../src/jobs/boss'
import { RUN_STEP_QUEUE } from '../src/jobs/run-step'
import { appendMessage, readRunMessages } from '../src/loop/bus'
import {
  appendHumanInstruction,
  findPendingInstructions,
  instructionsBlock,
} from '../src/loop/instructions'
import { loopFromRunState } from '../src/projects/derive'

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
// Une instance réellement démarrée : la reprise DOIT ré-enfiler un job
// `run.step`, et c'est précisément ce qu'on veut pouvoir prouver ici.
const boss: PgBoss = createBoss(env)
const app = await buildApp({ db, boss })

let cookie: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await createUser(db, 'florian', 'motdepasse-de-test')
  await boss.start()
  await boss.createQueue(RUN_STEP_QUEUE)
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
  await boss.stop()
  await db.destroy()
})

async function pendingRunStepJobs(runId: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from pgboss.job
    where name = ${RUN_STEP_QUEUE} and data->>'runId' = ${runId}
  `.execute(db)
  return Number(rows.rows[0]?.count ?? 0)
}

function post(url: string, payload: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url, payload, cookies: { hm_session: cookie } })
}

function get(url: string) {
  return app.inject({ method: 'GET', url, cookies: { hm_session: cookie } })
}

async function seedRun(state = 'coding'): Promise<string> {
  const globe = await db.selectFrom('globes').select('id').executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Projet Controle',
      slug: `projet-controle-${randomUUID()}`,
      repo_full_name: 'desura/x',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'Un step', specs: '## s' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id, state: state as 'coding', iteration: 1 })
    .returning('id')
    .executeTakeFirstOrThrow()
  return run.id
}

async function stateOf(runId: string): Promise<string> {
  const row = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  return row.state
}

// --- Authentification et validation ---------------------------------------

test('les routes de controle exigent le cookie de session', async () => {
  const id = randomUUID()
  for (const path of ['pause', 'resume', 'stop', 'instruct']) {
    const res = await app.inject({ method: 'POST', url: `/api/runs/${id}/${path}`, payload: {} })
    expect(res.statusCode).toBe(401)
  }
})

test('un identifiant mal forme est un 400, un run inconnu un 404', async () => {
  expect((await post('/api/runs/pas-un-uuid/pause')).statusCode).toBe(400)
  expect((await post(`/api/runs/${randomUUID()}/pause`)).statusCode).toBe(404)
})

// --- Pause et reprise ------------------------------------------------------

test('pause puis reprise ramene le run a l etape exacte ou il s etait arrete', async () => {
  const runId = await seedRun('reviewing')

  const paused = await post(`/api/runs/${runId}/pause`)
  expect(paused.statusCode).toBe(200)
  expect(paused.json().state).toBe('paused_human')
  expect(await stateOf(runId)).toBe('paused_human')

  const resumed = await post(`/api/runs/${runId}/resume`)
  expect(resumed.statusCode).toBe(200)
  // Repart en `reviewing`, pas au début de la boucle.
  expect(resumed.json().state).toBe('reviewing')
  expect(await stateOf(runId)).toBe('reviewing')
})

test('un run repris AVANCE vraiment : un job run.step est re-enfile', async () => {
  const runId = await seedRun('coding')
  await post(`/api/runs/${runId}/pause`)
  // En pause, le worker a cessé de se ré-enfiler : rien ne doit attendre.
  expect(await pendingRunStepJobs(runId)).toBe(0)

  await post(`/api/runs/${runId}/resume`)
  // Sans ce job, le run repartirait en base sans que personne ne le fasse
  // avancer — exactement le piège dans lequel le scheduler de budget est tombé.
  expect(await pendingRunStepJobs(runId)).toBe(1)
})

test('une reprise refusee ne re-enfile rien', async () => {
  const runId = await seedRun('coding')
  expect((await post(`/api/runs/${runId}/resume`)).statusCode).toBe(409)
  // Le `boss.send` ne doit avoir lieu qu'après une transition réussie.
  expect(await pendingRunStepJobs(runId)).toBe(0)
})

test('la pause manuelle n est PAS paused_budget', async () => {
  // Le cœur de la décision : le scheduler de budget reprend tous les runs en
  // `paused_budget` dès que la jauge est sous le seuil de reprise (cas
  // nominal). Une pause manuelle rangée là serait levée au tick suivant.
  const runId = await seedRun('coding')
  await post(`/api/runs/${runId}/pause`)
  expect(await stateOf(runId)).not.toBe('paused_budget')
})

test('un run en pause manuelle est invisible au scheduler de budget', async () => {
  const runId = await seedRun('coding')
  await post(`/api/runs/${runId}/pause`)

  // Reproduit les deux filtres de `runBudgetTick` : celui de la pause
  // (loopFromRunState === 'run') et celui de la reprise (state ===
  // 'paused_budget'). Aucun des deux ne doit ramener ce run.
  const row = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()

  expect(loopFromRunState(row.state)).not.toBe('run')
  expect(row.state).not.toBe('paused_budget')
})

test('reprendre un run qui n est pas en pause manuelle est un 409, pas un 500', async () => {
  const runId = await seedRun('coding')
  const res = await post(`/api/runs/${runId}/resume`)
  expect(res.statusCode).toBe(409)
  expect(res.json().error).toBe('transition_refusee')
  expect(res.json().state).toBe('coding')
})

// --- Arrêt -----------------------------------------------------------------

test('l arret termine le run en stopped, distinct de failed', async () => {
  const runId = await seedRun('judging')
  const res = await post(`/api/runs/${runId}/stop`, { reason: 'ça part de travers' })
  expect(res.statusCode).toBe(200)
  expect(res.json().state).toBe('stopped')
  expect(await stateOf(runId)).toBe('stopped')

  // Terminal : `ended_at` est posé, donc la durée est calculable.
  const body = (await get(`/api/runs/${runId}`)).json()
  expect(body.state).toBe('stopped')
  expect(body.durationSeconds).not.toBeNull()
})

test('un arret ne compte ni comme step termine ni comme echec dans les analytics', async () => {
  const runId = await seedRun('coding')
  await post(`/api/runs/${runId}/stop`)

  // `analytics/repo.ts` ne compte `stepsDone` que sur `state === 'done'`.
  const row = await db
    .selectFrom('runs')
    .select('state')
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  expect(row.state).not.toBe('done')
  expect(row.state).not.toBe('failed')
})

test('on peut arreter un run mis en pause, sans avoir a le reprendre d abord', async () => {
  const runId = await seedRun('coding')
  await post(`/api/runs/${runId}/pause`)
  const res = await post(`/api/runs/${runId}/stop`)
  expect(res.statusCode).toBe(200)
  expect(await stateOf(runId)).toBe('stopped')
})

test('on peut arreter un run bloque en attente humaine', async () => {
  const runId = await seedRun('awaiting_human')
  expect((await post(`/api/runs/${runId}/stop`)).statusCode).toBe(200)
  expect(await stateOf(runId)).toBe('stopped')
})

test('arreter un run deja arrete est un 409', async () => {
  const runId = await seedRun('coding')
  await post(`/api/runs/${runId}/stop`)
  expect((await post(`/api/runs/${runId}/stop`)).statusCode).toBe(409)
})

// --- Consigne injectée -----------------------------------------------------

test('une consigne apparait dans la timeline du run', async () => {
  const runId = await seedRun('coding')
  const res = await post(`/api/runs/${runId}/instruct`, {
    role: 'dev',
    body: 'Ne touche pas au schéma de base.',
  })
  expect(res.statusCode).toBe(200)

  const body = (await get(`/api/runs/${runId}`)).json()
  const consigne = body.timeline.find((m: { kind: string }) => m.kind === 'correction')
  expect(consigne.body).toBe('Ne touche pas au schéma de base.')
  expect(consigne.toRole).toBe('dev')
  // `system`, jamais `garant` : sinon `framing.ts::findLatestCorrection` la
  // prendrait pour un correctif de verdict.
  expect(consigne.fromRole).toBe('system')
})

test('un role dont aucun handler ne lit le bus est refuse', async () => {
  const runId = await seedRun('reviewing')
  // Accepter 'reviewer' ferait avaler une consigne que personne ne lirait
  // jamais — un silence pire qu'un refus.
  for (const role of ['reviewer', 'judge', 'majordome']) {
    const res = await post(`/api/runs/${runId}/instruct`, { role, body: 'x' })
    expect(res.statusCode).toBe(400)
  }
})

test('une consigne vide est refusee', async () => {
  const runId = await seedRun('coding')
  expect((await post(`/api/runs/${runId}/instruct`, { role: 'dev', body: '' })).statusCode).toBe(
    400,
  )
})

test('on ne peut pas parler a un run termine', async () => {
  const runId = await seedRun('coding')
  await post(`/api/runs/${runId}/stop`)
  const res = await post(`/api/runs/${runId}/instruct`, { role: 'dev', body: 'trop tard' })
  expect(res.statusCode).toBe(409)
  expect(res.json().error).toBe('run_termine')
})

test('la reponse dit honnetement QUAND la consigne sera lue', async () => {
  const runId = await seedRun('coding')
  const res = await post(`/api/runs/${runId}/instruct`, { role: 'dev', body: 'une consigne' })
  // Pas d'injection temps réel : le front doit pouvoir le dire à Florian.
  expect(res.json().readAt).toContain('prochaine invocation')
})

// --- La lecture des consignes, sans passer par HTTP -------------------------

test('une consigne reste en attente tant que le role n a rien produit apres elle', async () => {
  const runId = await seedRun('coding')
  await appendHumanInstruction(db, { runId, toRole: 'dev', body: 'Priorise le mobile.' })

  expect(findPendingInstructions(await readRunMessages(db, runId), 'dev')).toEqual([
    'Priorise le mobile.',
  ])
})

test('une consigne cesse d etre en attente une fois que le role a travaille avec', async () => {
  const runId = await seedRun('coding')
  await appendHumanInstruction(db, { runId, toRole: 'dev', body: 'Priorise le mobile.' })
  // Le dev rend sa passation : il a travaillé en la connaissant.
  await appendMessage(db, {
    runId,
    fromRole: 'dev',
    toRole: 'garant',
    kind: 'report',
    body: 'Fait.',
  })

  // Sans ça, la consigne serait ré-appliquée à chaque tour dev↔reviewer et à
  // l'itération suivante, où elle n'a plus de sens.
  expect(findPendingInstructions(await readRunMessages(db, runId), 'dev')).toEqual([])
})

test('une consigne adressee au garant n atteint pas le dev', async () => {
  const runId = await seedRun('framing')
  await appendHumanInstruction(db, { runId, toRole: 'garant', body: 'Cadre plus serré.' })

  const messages = await readRunMessages(db, runId)
  expect(findPendingInstructions(messages, 'garant')).toEqual(['Cadre plus serré.'])
  expect(findPendingInstructions(messages, 'dev')).toEqual([])
})

test('une consigne humaine n est pas confondue avec un correctif du garant', async () => {
  const runId = await seedRun('framing')
  await appendMessage(db, {
    runId,
    fromRole: 'garant',
    toRole: 'dev',
    kind: 'correction',
    body: 'Correctif du verdict.',
  })

  // `findPendingInstructions` ne doit ramener que ce qui porte le marqueur
  // humain, sinon le correctif du garant serait réinjecté comme une consigne.
  expect(findPendingInstructions(await readRunMessages(db, runId), 'dev')).toEqual([])
})

test('sans consigne, le bloc injecte est vide (prompt inchange)', () => {
  expect(instructionsBlock([], '## Consigne de pilotage')).toEqual([])
})

test('avec consignes, le bloc porte le titre et chaque consigne', () => {
  const block = instructionsBlock(['a', 'b'], '## Consigne de pilotage')
  expect(block[0]).toBe('## Consigne de pilotage')
  expect(block).toContain('- a')
  expect(block).toContain('- b')
})

// --- Demarrer une boucle (POST /api/steps/:id/start) ---

async function seedStep(): Promise<string> {
  const globe = await db.selectFrom('globes').select('id').executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Projet Demarrage',
      slug: `projet-demarrage-${randomUUID()}`,
      repo_full_name: 'desura/x',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'Premier step', specs: '## s' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return step.id
}

async function jobCount(runId: string): Promise<number> {
  const row = await sql<{ n: string }>`
    select count(*)::text as n from pgboss.job
    where name = ${RUN_STEP_QUEUE} and data->>'runId' = ${runId}
  `.execute(db)
  return Number(row.rows[0]?.n ?? '0')
}

test('demarrer un step cree un run en framing ET enfile un job', async () => {
  const stepId = await seedStep()

  const res = await post(`/api/steps/${stepId}/start`, {})
  expect(res.statusCode).toBe(201)
  const { runId } = res.json()

  expect(await stateOf(runId)).toBe('framing')
  // Sans job, le run resterait en framing indefiniment : visible dans la
  // liste, et immobile.
  expect(await jobCount(runId)).toBe(1)

  const step = await db
    .selectFrom('steps')
    .select('status')
    .where('id', '=', stepId)
    .executeTakeFirstOrThrow()
  expect(step.status).toBe('running')
})

test('deux demarrages sur le meme step : le second est refuse en 409', async () => {
  const stepId = await seedStep()

  const a = await post(`/api/steps/${stepId}/start`, {})
  const b = await post(`/api/steps/${stepId}/start`, {})

  expect(a.statusCode).toBe(201)
  // 409 et non 400 : la requete est valide, c'est l'etat du monde qui s'y
  // oppose. L'ecran doit pouvoir proposer d'ouvrir le run en cours.
  expect(b.statusCode).toBe(409)
  expect(b.json().runId).toBe(a.json().runId)
  expect(b.json().state).toBe('framing')
})

test('un step dont le run est termine peut redemarrer', async () => {
  const stepId = await seedStep()
  const first = (await post(`/api/steps/${stepId}/start`, {})).json()
  await db
    .updateTable('runs')
    .set({ state: 'done', ended_at: new Date() })
    .where('id', '=', first.runId)
    .execute()

  const res = await post(`/api/steps/${stepId}/start`, {})
  expect(res.statusCode).toBe(201)
  expect(res.json().runId).not.toBe(first.runId)
})

test('un run en pause occupe toujours son step', async () => {
  const stepId = await seedStep()
  const first = (await post(`/api/steps/${stepId}/start`, {})).json()
  await db
    .updateTable('runs')
    .set({ state: 'paused_human', resume_state: 'coding' })
    .where('id', '=', first.runId)
    .execute()

  // Une pause n'est pas une fin : relancer creerait un second run sur le meme
  // step, avec deux verdicts contradictoires a la cle.
  expect((await post(`/api/steps/${stepId}/start`, {})).statusCode).toBe(409)
})

test('demarrer un step inconnu renvoie 404', async () => {
  expect((await post(`/api/steps/${randomUUID()}/start`, {})).statusCode).toBe(404)
})

test('demarrer exige une session', async () => {
  const stepId = await seedStep()
  const res = await app.inject({ method: 'POST', url: `/api/steps/${stepId}/start` })
  expect(res.statusCode).toBe(401)
})

test('la fin d un run remet steps.status : un step arrete redevient libre', async () => {
  const stepId = await seedStep()
  const { runId } = (await post(`/api/steps/${stepId}/start`, {})).json()

  const before = await db
    .selectFrom('steps')
    .select('status')
    .where('id', '=', stepId)
    .executeTakeFirstOrThrow()
  expect(before.status).toBe('running')

  await post(`/api/runs/${runId}/stop`, {})

  const after = await db
    .selectFrom('steps')
    .select('status')
    .where('id', '=', stepId)
    .executeTakeFirstOrThrow()
  // `pending` et non `failed` : un arret n'est pas un echec, et le step doit
  // redevenir relancable. Sans ca il resterait affiche « en cours » a jamais.
  expect(after.status).toBe('pending')

  // Et il est reellement relancable : c'est tout l'interet.
  expect((await post(`/api/steps/${stepId}/start`, {})).statusCode).toBe(201)
})

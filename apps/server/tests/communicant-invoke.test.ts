import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { submitClientEmailDraft } from '../src/communication/client-email'
import { invoquerCommunicant, sujetDepuisProd } from '../src/communication/invoke'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { createInboxItem, getInboxItem } from '../src/inbox/repo'
import { createFakeGmailAccount } from '../src/integrations/gmail'
import { createBoss } from '../src/jobs/boss'
import { COMMUNICANT_QUEUE } from '../src/jobs/communicant'
import { RUN_STEP_QUEUE } from '../src/jobs/run-step'
import { createFakeAdapter } from '../src/runtime/fake'
import type { RuntimeAdapter, SendOptions } from '../src/runtime/types'
import { ensureGlobe } from './fixtures'
import { stopBoss } from './stop-boss'

/**
 * Le communicant est enfin appelé (Phase 5, Task 5 · câblage).
 *
 * Il savait rédiger depuis la Phase 5 et personne ne l'invoquait jamais :
 * aucun état de boucle ne menait à lui, aucune route ne le réveillait. Ce
 * fichier vérifie les deux chemins qui existent désormais — la mise en prod
 * approuvée et la demande explicite — et surtout les deux abstentions : sans
 * fiche client, il ne travaille pas ; sans mise en prod approuvée, il n'est
 * pas réveillé.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const boss: PgBoss = createBoss(env)
const gmail = createFakeGmailAccount()
const observateurApp = adapterObservateur()
const app = await buildApp({ db, boss, adapter: observateurApp.adapter })

let cookie: string

/**
 * Adapter de test qui observe la session et peut simuler l'appel de l'outil.
 *
 * Le FakeAdapter ordinaire ne câble aucun serveur MCP : un `replies` scripté
 * ne peut donc pas déclencher `create_draft`. `pendantEnvoi` prend sa place —
 * ce que ferait le modèle en appelant l'outil, exécuté au même moment. Ce
 * n'est pas le vrai transport MCP, mais c'est le vrai effet observé.
 */
interface Observateur {
  adapter: RuntimeAdapter
  sessions: { roleKey: string; systemPrompt: string }[]
  envois: { message: string; options?: SendOptions }[]
}

function adapterObservateur(): Observateur {
  const base = createFakeAdapter()
  const sessions: Observateur['sessions'] = []
  const envois: Observateur['envois'] = []

  const adapter: RuntimeAdapter = {
    ...base,
    async createSession(options) {
      sessions.push({ roleKey: options.roleKey, systemPrompt: options.systemPrompt })
      return base.createSession(options)
    },
    async send(session, message, options) {
      envois.push({ message, ...(options ? { options } : {}) })
      return base.send(session, message, options)
    },
  }

  return { adapter, sessions, envois }
}

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await seedRoleTemplates(db)
  await createUser(db, 'florian', 'motdepasse-de-test')
  await boss.start()
  await boss.createQueue(RUN_STEP_QUEUE)
  await boss.createQueue(COMMUNICANT_QUEUE)
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
  await stopBoss(boss)
  await db.destroy()
})

async function creerProjet(opts: { avecClient: boolean }): Promise<{
  projectId: string
  slug: string
}> {
  const globe = await ensureGlobe(db)
  let clientId: string | null = null
  if (opts.avecClient) {
    const client = await db
      .insertInto('clients')
      .values({
        name: `Atelier ${randomUUID().slice(0, 8)}`,
        tone: 'Vouvoiement · direct · zéro jargon.',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    clientId = client.id
  }
  const slug = `p-invoke-${randomUUID()}`
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      ...(clientId ? { client_id: clientId } : {}),
      name: 'Boutique',
      slug,
      repo_full_name: 'desura/boutique',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { projectId: project.id, slug }
}

test("sans fiche client, le communicant n'est même pas réveillé", async () => {
  const { projectId } = await creerProjet({ avecClient: false })
  const obs = adapterObservateur()

  const result = await invoquerCommunicant({
    db,
    adapter: obs.adapter,
    drafts: gmail.drafts,
    projectId,
    sujet: 'La boutique est en ligne.',
  })

  expect(result.itemId).toBeNull()
  expect(result.raison).toMatch(/aucune fiche client/)
  // Le point qui compte : aucun échange modèle. Une abstention qui coûterait
  // quand même des tokens ne serait pas une abstention.
  expect(obs.sessions).toHaveLength(0)
  expect(obs.envois).toHaveLength(0)
})

test('avec une fiche client, il reçoit la fiche ET le brouillon, jamais l’envoi', async () => {
  const { projectId } = await creerProjet({ avecClient: true })
  const obs = adapterObservateur()

  await invoquerCommunicant({
    db,
    adapter: obs.adapter,
    drafts: gmail.drafts,
    projectId,
    sujet: 'La fiche produit s’affiche à nouveau sur mobile.',
  })

  expect(obs.sessions).toHaveLength(1)
  expect(obs.sessions[0]?.roleKey).toBe('communicant')

  const outils = obs.envois[0]?.options?.extraAllowedTools ?? []
  // Les deux surfaces sont fusionnées, pas substituées : sans `client_kb` il
  // écrirait sans le ton, sans `gmail_draft` il ne pourrait rien soumettre.
  expect(new Set(outils)).toEqual(
    new Set(['mcp__client_kb__lookup', 'mcp__gmail_draft__create_draft']),
  )
  for (const nom of outils) expect(nom).not.toMatch(/send|envoi/i)
  expect(Object.keys(obs.envois[0]?.options?.extraMcpServers ?? {}).sort()).toEqual([
    'client_kb',
    'gmail_draft',
  ])
})

test("un communicant qui n'écrit rien le dit, il n'invente pas d'item", async () => {
  const { projectId } = await creerProjet({ avecClient: true })
  const obs = adapterObservateur()

  const result = await invoquerCommunicant({
    db,
    adapter: obs.adapter,
    drafts: gmail.drafts,
    projectId,
    sujet: 'Rien de visible pour le client.',
  })

  // Le fake ne crée aucun brouillon : on lit ce qui existe en base plutôt que
  // de croire la réponse du modèle. Un agent qui affirmerait avoir rédigé
  // sans appeler l'outil ne produirait rien ici — c'est le but.
  expect(result.itemId).toBeNull()
  expect(result.raison).toMatch(/rien jugé utile/)
})

test("quand l'outil est réellement appelé, l'item de validation apparaît", async () => {
  const { projectId } = await creerProjet({ avecClient: true })
  const base = createFakeAdapter()
  const adapter: RuntimeAdapter = {
    ...base,
    async send(session, message, options) {
      // Ce que ferait le modèle en appelant `create_draft`.
      await submitClientEmailDraft(
        { db, drafts: gmail.drafts, projectId },
        {
          to: 'camille@boutique.fr',
          subject: 'Votre boutique est en ligne',
          body: 'Bonjour Camille,\n\nVotre boutique est en ligne depuis ce matin.\n\nFlorian',
        },
      )
      return base.send(session, message, options)
    },
  }

  const result = await invoquerCommunicant({
    db,
    adapter,
    drafts: gmail.drafts,
    projectId,
    sujet: 'La boutique est en ligne.',
  })

  expect(result.itemId).not.toBeNull()
  const item = await getInboxItem(db, result.itemId as string)
  expect(item?.type).toBe('approval')
  expect(item?.subtype).toBe('email')
  expect(item?.fromRole).toBe('communicant')
  expect(item?.status).toBe('open')
  // Rédigé, jamais envoyé.
  expect(gmail.sent).toHaveLength(0)
})

test('le sujet donné au communicant reste brut : traduire est SON métier', () => {
  const sujet = sujetDepuisProd('Boutique · mise en prod', {
    prod: {
      step: 'Step 3/8 · Fiche produit',
      verdict: 'Conforme',
      changes: 'src/product.tsx',
    },
  })
  expect(sujet).toContain('Step 3/8 · Fiche produit')
  expect(sujet).toContain('src/product.tsx')
  // Consigne explicite de ne pas écrire quand rien n'est visible côté client :
  // un email « on a mis à jour une dépendance » vaut moins que pas d'email.
  expect(sujet).toMatch(/n'écris pas/)

  // Un payload sans bloc `prod` (item écrit avant la Phase 5) ne fait pas
  // tomber la mise en file : il donne un sujet plus pauvre, c'est tout.
  const minimal = sujetDepuisProd('Sans contexte', {})
  expect(minimal).toContain('Sans contexte')
  expect(minimal.split('\n').length).toBeGreaterThan(1)
})

/** Combien de jobs attendent dans la queue de rédaction, à cet instant. */
async function jobsEnAttente(): Promise<number> {
  const row = await sql<{ n: string }>`
    select count(*)::text as n from pgboss.job
    where name = ${COMMUNICANT_QUEUE} and state in ('created', 'active')
  `.execute(db)
  return Number(row.rows[0]?.n ?? '0')
}

async function creerItemProd(projectId: string): Promise<string> {
  const item = await createInboxItem(db, {
    type: 'approval',
    subtype: 'prod',
    projectId,
    fromRole: 'garant',
    title: 'Boutique · mise en prod',
    payload: { prod: { step: 'Step 1/3 · Fiche produit', verdict: 'Conforme' } },
  })
  return item.id
}

function resoudre(id: string, response: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/inbox/${id}/resolve`,
    cookies: { hm_session: cookie },
    payload: { response },
  })
}

test('approuver une mise en prod enfile une rédaction, sans faire attendre Florian', async () => {
  const { projectId } = await creerProjet({ avecClient: true })
  const avant = await jobsEnAttente()

  const res = await resoudre(await creerItemProd(projectId), { approved: true })

  expect(res.statusCode).toBe(200)
  expect(res.json().emailDraftQueued).toBe(true)
  // Enfilé, pas exécuté : la requête ne porte aucun échange modèle. C'est ce
  // qui distingue « approuver » d'« attendre une minute après avoir approuvé ».
  expect(await jobsEnAttente()).toBe(avant + 1)
  expect(observateurApp.sessions).toHaveLength(0)
})

test('refuser une mise en prod n’enfile rien : il n’y a rien à annoncer', async () => {
  const { projectId } = await creerProjet({ avecClient: true })
  const avant = await jobsEnAttente()

  const res = await resoudre(await creerItemProd(projectId), {
    approved: false,
    text: 'On attend jeudi.',
  })

  expect(res.statusCode).toBe(200)
  expect(res.json().emailDraftQueued).toBe(false)
  expect(await jobsEnAttente()).toBe(avant)
})

test('résoudre une question ordinaire ne réveille pas le communicant', async () => {
  const { projectId } = await creerProjet({ avecClient: true })
  const avant = await jobsEnAttente()
  const item = await createInboxItem(db, {
    type: 'question',
    projectId,
    fromRole: 'garant',
    title: 'Quel ton pour la page contact ?',
    payload: {},
  })

  const res = await resoudre(item.id, { text: 'Vouvoiement.' })
  expect(res.statusCode).toBe(200)
  expect(res.json().emailDraftQueued).toBe(false)
  expect(await jobsEnAttente()).toBe(avant)
})

test('la route à la demande refuse un projet inconnu, et un projet sans client', async () => {
  const inconnu = await app.inject({
    method: 'POST',
    url: '/api/projects/nexiste-pas/communicant',
    cookies: { hm_session: cookie },
    payload: { sujet: 'Relance sur les visuels.' },
  })
  expect(inconnu.statusCode).toBe(404)

  const { slug } = await creerProjet({ avecClient: false })
  const sansClient = await app.inject({
    method: 'POST',
    url: `/api/projects/${slug}/communicant`,
    cookies: { hm_session: cookie },
    payload: { sujet: 'Relance sur les visuels.' },
  })
  // 422 et pas 200 avec un corps vide : l'écran doit pouvoir dire pourquoi.
  expect(sansClient.statusCode).toBe(422)
  expect(sansClient.json().error).toBe('client_absent')
})

test('la route à la demande exige une session et un sujet', async () => {
  const { slug } = await creerProjet({ avecClient: true })
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${slug}/communicant`,
        payload: { sujet: 'Relance.' },
      })
    ).statusCode,
  ).toBe(401)

  const vide = await app.inject({
    method: 'POST',
    url: `/api/projects/${slug}/communicant`,
    cookies: { hm_session: cookie },
    payload: { sujet: '' },
  })
  expect(vide.statusCode).toBe(400)
})

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLE_KEYS } from '@silithid/shared'
import { sql } from 'kysely'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import {
  createClientEmailMcpSurface,
  sendApprovedClientEmail,
  submitClientEmailDraft,
} from '../src/communication/client-email'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRoleTemplates } from '../src/db/seed'
import { databaseUrl, loadEnv } from '../src/env'
import { getInboxItem } from '../src/inbox/repo'
import {
  type FetchLike,
  HumanSendApproval,
  assertDraftOnlyGmailPolicy,
  buildMimeMessage,
  createFakeGmailAccount,
  createGmailHttpAccount,
} from '../src/integrations/gmail'
import { createBoss } from '../src/jobs/boss'
import { RUN_STEP_QUEUE } from '../src/jobs/run-step'
import { readRunMessages } from '../src/loop/bus'
import { resolveToolPolicy } from '../src/runtime/tools'
import type { ToolPolicy } from '../src/runtime/types'
import { stopBoss } from './stop-boss'

/**
 * Task 5, Phase 5 · « le communicant rédige, il n'envoie jamais ».
 *
 * Le test qui compte n'est pas « l'agent n'a pas envoyé » : une abstention ne
 * prouve rien, le tour suivant peut décider autrement. Ce qui est vérifié ici
 * est qu'il n'existe rien à appeler pour envoyer, et que le seul chemin
 * d'envoi exige une preuve de validation humaine qu'aucun agent ne peut
 * produire. Aucun token consommé : la surface d'outils se calcule sans
 * modèle, et le compte Gmail est factice.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))
const boss: PgBoss = createBoss(env)
const gmail = createFakeGmailAccount()
const app = await buildApp({ db, boss, gmailSender: gmail.sender })

let cookie: string

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await seedRoleTemplates(db)
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
  await stopBoss(boss)
  await db.destroy()
})

async function createProjectAndRun(): Promise<{ projectId: string; runId: string }> {
  const globe = await db.selectFrom('globes').select('id').executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Reparea',
      slug: `p-communicant-${randomUUID()}`,
      repo_full_name: 'desura/reparea',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'T', specs: '## S' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { projectId: project.id, runId: run.id }
}

const BODY =
  'Bonjour Camille,\n\nLa fiche produit s’affiche à nouveau correctement sur mobile depuis ce matin.\n\nFlorian'

/** Politique du communicant telle qu'elle est réellement persistée en base. */
async function communicantPolicy(): Promise<ToolPolicy> {
  const row = await db
    .selectFrom('role_templates')
    .select('tools')
    .where('key', '=', 'communicant')
    .where('project_type', '=', 'generic')
    .executeTakeFirstOrThrow()
  return row.tools as unknown as ToolPolicy
}

test("la surface MCP du communicant n'expose qu'un outil, et il ne fait rien partir", async () => {
  const policy = await communicantPolicy()
  const surface = createClientEmailMcpSurface({
    db,
    drafts: gmail.drafts,
    projectId: randomUUID(),
    policyMcp: policy.mcp,
  })

  // Les noms viennent du tableau réellement passé à `createSdkMcpServer`, pas
  // d'une liste recopiée à côté : c'est la surface que le modèle voit.
  expect(surface.toolNames).toEqual(['create_draft'])
  expect(surface.sendOptions.extraAllowedTools).toEqual(['mcp__gmail_draft__create_draft'])
  for (const name of surface.toolNames) {
    expect(name).not.toMatch(/send|envoi|envoyer/i)
  }
})

test("l'agent ne PEUT PAS envoyer : rien de tel n'existe dans sa surface d'outils", async () => {
  const policy = await communicantPolicy()
  const resolved = resolveToolPolicy(policy)
  const surface = createClientEmailMcpSurface({
    db,
    drafts: gmail.drafts,
    projectId: randomUUID(),
    policyMcp: policy.mcp,
  })

  // Tout ce que le modèle peut invoquer : les outils natifs autorisés (aucun
  // ici) plus les outils MCP explicitement câblés pour l'échange.
  const callable = new Set([
    ...resolved.sdkOptions.tools,
    ...(surface.sendOptions.extraAllowedTools ?? []),
  ])
  expect(callable).toEqual(new Set(['mcp__gmail_draft__create_draft']))

  // Même en le demandant explicitement, il n'y a aucun nom à appeler.
  for (const attempt of [
    'Bash',
    'mcp__gmail__send',
    'mcp__gmail_draft__send',
    'mcp__gmail_draft__send_draft',
    'mcp__gmail_send__send',
    'send_email',
  ]) {
    expect(callable.has(attempt)).toBe(false)
  }

  // Et aucun serveur MCP de l'hôte (le Gmail personnel de Florian, entre
  // autres) ne peut réapparaître par héritage de configuration : c'est la
  // moitié de la frontière posée en Phase 2, elle tient toujours ici.
  expect(resolved.sdkOptions.mcpServers).toEqual({})
  expect(resolved.sdkOptions.strictMcpConfig).toBe(true)
  expect(resolved.sdkOptions.tools).toEqual([])
})

test('ajouter gmail_send à un rôle fait échouer la construction de la surface', () => {
  expect(() => assertDraftOnlyGmailPolicy(['gmail_draft', 'client_kb', 'bus'])).not.toThrow()
  expect(() => assertDraftOnlyGmailPolicy(['gmail_send'])).toThrow(/gmail_draft/)
  expect(() =>
    createClientEmailMcpSurface({
      db,
      drafts: gmail.drafts,
      projectId: randomUUID(),
      policyMcp: ['gmail_draft', 'gmail_send', 'bus'],
    }),
  ).toThrow(/gmail_send/)
})

test('la politique persistée du communicant reste bash: false, fs: none, Gmail en brouillon', async () => {
  const policy = await communicantPolicy()
  expect(policy.bash).toBe(false)
  expect(policy.fs).toBe('none')
  expect(policy.mcp).toContain('gmail_draft')
  expect(policy.mcp.filter((n) => n.includes('gmail'))).toEqual(['gmail_draft'])
})

test('aucun rôle ne déclare une entrée MCP Gmail autre que le brouillon', async () => {
  const rows = await db.selectFrom('role_templates').select(['key', 'tools']).execute()
  expect(rows).toHaveLength(ROLE_KEYS.length)
  for (const row of rows) {
    const policy = row.tools as unknown as ToolPolicy
    expect(() => assertDraftOnlyGmailPolicy(policy.mcp), `rôle ${row.key}`).not.toThrow()
  }
})

test('un brouillon crée un item d’approbation qui se décide sans ouvrir Gmail', async () => {
  const { projectId, runId } = await createProjectAndRun()

  const { draftId, inboxItemId } = await submitClientEmailDraft(
    { db, drafts: gmail.drafts, projectId, runId },
    {
      to: 'camille@reparea.fr',
      subject: 'Fiche produit · c’est réparé',
      body: BODY,
    },
  )

  const item = await getInboxItem(db, inboxItemId)
  expect(item?.type).toBe('approval')
  expect(item?.subtype).toBe('email')
  expect(item?.fromRole).toBe('communicant')
  expect(item?.status).toBe('open')
  // De quoi décider sans ouvrir Gmail : destinataire, objet, corps complet.
  expect(item?.payload).toMatchObject({
    to: 'camille@reparea.fr',
    subject: 'Fiche produit · c’est réparé',
    body: BODY,
    draftId,
  })

  // Le brouillon existe côté Gmail, et rien n'est parti.
  expect(gmail.drafted.some((d) => d.draftId === draftId)).toBe(true)
  expect(gmail.sent.some((s) => s.draftId === draftId)).toBe(false)

  const messages = await readRunMessages(db, runId)
  expect(messages.at(-1)?.fromRole).toBe('communicant')
  expect(messages.at(-1)?.body).toContain('En attente de validation humaine')
})

test('sans validation humaine, aucun envoi n’est possible même côté serveur', async () => {
  const { projectId } = await createProjectAndRun()
  const { inboxItemId } = await submitClientEmailDraft(
    { db, drafts: gmail.drafts, projectId },
    { to: 'camille@reparea.fr', subject: 'Devis · suite', body: BODY },
  )
  const open = await getInboxItem(db, inboxItemId)
  if (!open) throw new Error('item introuvable')

  // Le chemin serveur refuse un item non résolu, sans rien envoyer...
  expect(await sendApprovedClientEmail(db, gmail.sender, open)).toBeNull()
  expect(gmail.sent).toHaveLength(0)

  // ...et la preuve de validation, seule clé du port d'envoi, refuse d'être
  // fabriquée à partir d'un item ouvert ou d'un refus.
  expect(() =>
    HumanSendApproval.fromResolvedInboxItem({
      id: open.id,
      type: open.type,
      subtype: open.subtype,
      status: open.status,
      humanResponse: { approved: true },
      payload: open.payload,
    }),
  ).toThrow(/non résolu/)
  expect(() =>
    HumanSendApproval.fromResolvedInboxItem({
      id: open.id,
      type: open.type,
      subtype: open.subtype,
      status: 'done',
      humanResponse: { approved: false },
      payload: open.payload,
    }),
  ).toThrow(/approbation humaine/)
})

test("la validation humaine déclenche l'envoi, côté serveur", async () => {
  const { projectId, runId } = await createProjectAndRun()
  const { draftId, inboxItemId } = await submitClientEmailDraft(
    { db, drafts: gmail.drafts, projectId, runId },
    { to: 'camille@reparea.fr', subject: 'Point d’avancement · août', body: BODY },
  )

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${inboxItemId}/resolve`,
    cookies: { hm_session: cookie },
    payload: { response: { approved: true } },
  })

  expect(res.statusCode).toBe(200)
  expect(res.json().emailSent).toBe(true)
  expect(gmail.sent.map((s) => s.draftId)).toContain(draftId)

  const item = await getInboxItem(db, inboxItemId)
  expect(item?.status).toBe('done')
  expect(item?.payload.sent).toMatchObject({ messageId: `message-${draftId}` })

  const messages = await readRunMessages(db, runId)
  expect(messages.at(-1)?.body).toContain('Email client envoyé après validation humaine')
})

test('un refus laisse le brouillon en place et n’envoie rien', async () => {
  const { projectId } = await createProjectAndRun()
  const { draftId, inboxItemId } = await submitClientEmailDraft(
    { db, drafts: gmail.drafts, projectId },
    { to: 'camille@reparea.fr', subject: 'Relance · devis', body: BODY },
  )

  const res = await app.inject({
    method: 'POST',
    url: `/api/inbox/${inboxItemId}/resolve`,
    cookies: { hm_session: cookie },
    payload: { response: { approved: false, text: 'Trop tôt, on attend jeudi.' } },
  })

  expect(res.statusCode).toBe(200)
  expect(res.json().emailSent).toBe(false)
  expect(gmail.sent.map((s) => s.draftId)).not.toContain(draftId)
  // Le brouillon reste : refuser n'est pas supprimer.
  expect(gmail.drafted.some((d) => d.draftId === draftId)).toBe(true)
})

test('un tiret cadratin fait refuser le brouillon, pas seulement gronder l’agent', async () => {
  const { projectId } = await createProjectAndRun()
  await expect(
    submitClientEmailDraft(
      { db, drafts: gmail.drafts, projectId },
      {
        to: 'camille@reparea.fr',
        subject: 'Fiche produit — réparée',
        body: BODY,
      },
    ),
  ).rejects.toThrow(/cadratin/)
})

test('le prompt du communicant ne contient aucun tiret cadratin et envoie lire la fiche client', async () => {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    '../src/db/seeds/role_templates/communicant.md',
  )
  const prompt = await readFile(path, 'utf8')

  expect(prompt).not.toContain('—')
  expect(prompt).toContain('·')
  expect(prompt).toContain('client_kb.lookup')
  expect(prompt).toMatch(/brouillon/i)
  expect(prompt).toMatch(/validation/i)
})

test('le message MIME est un RFC 2822 valide, objet accentué encodé', () => {
  const mime = buildMimeMessage(
    {
      to: 'camille@reparea.fr',
      cc: ['compta@reparea.fr'],
      subject: 'Devis · août',
      body: 'Bonjour',
    },
    'florian@desura.fr',
  )
  expect(mime).toContain('From: florian@desura.fr')
  expect(mime).toContain('To: camille@reparea.fr')
  expect(mime).toContain('Cc: compta@reparea.fr')
  // Objet non ASCII : encoded-word RFC 2047, sinon les accents arrivent cassés.
  expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from('Devis · août').toString('base64')}?=`)
  const body = mime.split('\r\n\r\n')[1] ?? ''
  expect(Buffer.from(body, 'base64').toString('utf8')).toBe('Bonjour')
})

test('le compte HTTP ne touche jamais drafts/send depuis la surface de rédaction', async () => {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url)
    const payload = url.endsWith('/drafts')
      ? { id: 'd1', message: { threadId: 't1' } }
      : { id: 'm1', threadId: 't1' }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
  }
  const account = createGmailHttpAccount({
    from: 'florian@desura.fr',
    accessToken: async () => 'jeton-de-test',
    fetchImpl,
  })

  const ref = await account.drafts.createDraft({
    to: 'camille@reparea.fr',
    subject: 'Objet',
    body: 'Corps',
  })
  expect(ref).toEqual({ draftId: 'd1', threadId: 't1' })
  expect(calls).toEqual(['https://gmail.googleapis.com/gmail/v1/users/me/drafts'])
  expect(calls.some((u) => u.includes('send'))).toBe(false)

  const approval = HumanSendApproval.fromResolvedInboxItem({
    id: 'item-1',
    type: 'approval',
    subtype: 'email',
    status: 'done',
    humanResponse: { approved: true },
    payload: { draftId: 'd1' },
  })
  expect(await account.sender.sendDraft(approval)).toEqual({ messageId: 'm1', threadId: 't1' })
  expect(calls.at(-1)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send')
})

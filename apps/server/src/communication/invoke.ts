import { tmpdir } from 'node:os'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import type { GmailDraftPort } from '../integrations/gmail'
import { createClientKbSurface, readPolicyMcp } from '../knowledge/client-kb'
import { resolveProjectRole } from '../loop/roles'
import type { RuntimeAdapter, SendOptions } from '../runtime/types'
import { createClientEmailMcpSurface } from './client-email'

/**
 * Faire travailler le communicant.
 *
 * ## Pourquoi ce n'est PAS un état de la boucle
 *
 * Le communicant sait rédiger depuis la Phase 5, et rien ne l'appelait — il
 * n'existe pas d'état `communicant` dans la machine à états. La tentation
 * était d'en ajouter un ; c'est une mauvaise idée.
 *
 * Un huitième état ferait ATTENDRE chaque run sur un brouillon d'email. Or
 * écrire au client n'est pas une étape du travail : c'est une conséquence
 * possible du travail, qui n'a ni la même urgence ni le même destinataire.
 * Une boucle bloquée parce qu'un email n'est pas rédigé serait absurde.
 *
 * Le communicant est donc invoqué **en parallèle**, comme le gate de mise en
 * prod, l'alerte de contradiction du juge et les propositions de savoir : un
 * geste qui part du flux sans y entrer.
 *
 * ## Deux déclencheurs
 *
 * - **À la mise en prod approuvée** (queue `communicant.draft`, enfilée par
 *   `api/routes/inbox.ts`). Pas à la validation d'un step : un step validé
 *   n'est pas un évènement client. Le client n'a pas acheté des steps, il a
 *   acheté un résultat, et ce résultat n'existe pour lui qu'une fois EN
 *   LIGNE. C'est aussi le seul moment assez rare pour qu'un échange modèle
 *   complet se justifie — contrairement aux savoirs, qui voyagent gratuitement
 *   dans la sortie structurée du garant, celui-ci se paie.
 * - **À la demande**, depuis l'écran d'un projet, quand Florian veut écrire :
 *   une relance, un devis à confirmer, une mauvaise nouvelle à annoncer.
 *
 * Dans les deux cas la sortie est un BROUILLON soumis à validation. L'envoi
 * reste une action serveur qui exige une approbation humaine que l'agent ne
 * peut pas fabriquer (`HumanSendApproval`, `integrations/gmail.ts`).
 */

export interface InvoquerCommunicantDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  drafts: GmailDraftPort
  projectId: string
  /** Ce dont il doit parler. Un jalon franchi, une relance, ce que Florian dicte. */
  sujet: string
  runId?: string | null
}

export interface ResultatCommunicant {
  /** `null` quand le projet n'a pas de client : il n'y a personne à qui écrire. */
  itemId: string | null
  raison?: string
}

/**
 * Rédige un brouillon et le soumet à validation.
 *
 * Rend `null` sans rien faire quand le projet n'a pas de fiche client. Ce
 * n'est pas une panne : on ne sait pas à qui écrire, et surtout on ne connaît
 * pas le ton — or « le ton exact est dans chaque fiche client, il fait foi »
 * (règle de Florian). Inventer un ton pour un client dont on n'a pas la fiche
 * est exactement ce qu'un communicant ne doit jamais faire.
 */
export async function invoquerCommunicant(
  deps: InvoquerCommunicantDeps,
): Promise<ResultatCommunicant> {
  const projet = await deps.db
    .selectFrom('projects')
    .leftJoin('clients', 'clients.id', 'projects.client_id')
    .select([
      'projects.id as id',
      'projects.name as name',
      'clients.id as clientId',
      'clients.name as clientName',
    ])
    .where('projects.id', '=', deps.projectId)
    .executeTakeFirstOrThrow()

  if (!projet.clientId || !projet.clientName) {
    return {
      itemId: null,
      raison: 'aucune fiche client sur ce projet · on ne sait ni à qui écrire ni sur quel ton',
    }
  }

  const role = await resolveProjectRole(deps.db, projet.id, 'communicant')
  const mcp = readPolicyMcp(role.tools)

  // Les deux surfaces dont il a besoin : la fiche client (pour le ton, qui
  // fait foi) et la création de brouillon. Fusionnées, jamais substituées.
  const kb = createClientKbSurface({ db: deps.db, tools: role.tools, projetId: projet.id })
  const email = createClientEmailMcpSurface({
    db: deps.db,
    drafts: deps.drafts,
    projectId: projet.id,
    policyMcp: mcp,
    ...(deps.runId ? { runId: deps.runId } : {}),
  })

  const sendOptions: SendOptions = {
    extraMcpServers: { ...kb.sendOptions.extraMcpServers, ...email.sendOptions.extraMcpServers },
    extraAllowedTools: [
      ...(kb.sendOptions.extraAllowedTools ?? []),
      ...(email.sendOptions.extraAllowedTools ?? []),
    ],
  }

  const session = await deps.adapter.createSession({
    roleKey: 'communicant',
    systemPrompt: role.systemPrompt,
    // Le communicant n'a aucun accès fichier (`fs: 'none'`, db/seed.ts) : ce
    // cwd n'est jamais consulté.
    cwd: tmpdir(),
    tools: role.tools as never,
    onEvent: () => {},
  })

  const avant = await compterBrouillons(deps.db, projet.id)

  await deps.adapter.send(
    session,
    [
      `Projet « ${projet.name} », client « ${projet.clientName} ».`,
      '',
      `## Ce dont il faut parler\n${deps.sujet}`,
      '',
      "Rédige le brouillon et soumets-le. Si tu estimes qu'il n'y a rien à écrire au client à ce stade, ne crée aucun brouillon et dis-le en une phrase — un email inutile coûte plus cher qu'un email manquant.",
    ].join('\n'),
    sendOptions,
  )

  // On lit ce qui a RÉELLEMENT été créé plutôt que de croire la réponse : un
  // agent qui dit avoir rédigé sans appeler l'outil produirait un item
  // fantôme. Même principe que la lecture de `toolCalls` ailleurs.
  const item = await dernierBrouillon(deps.db, projet.id, avant)
  return item
    ? { itemId: item }
    : { itemId: null, raison: "le communicant n'a rien jugé utile d'écrire" }
}

async function compterBrouillons(db: Kysely<Database>, projectId: string): Promise<number> {
  const rows = await db
    .selectFrom('inbox_items')
    .select('id')
    .where('project_id', '=', projectId)
    .where('subtype', '=', 'email')
    .execute()
  return rows.length
}

async function dernierBrouillon(
  db: Kysely<Database>,
  projectId: string,
  avant: number,
): Promise<string | null> {
  const rows = await db
    .selectFrom('inbox_items')
    .select('id')
    .where('project_id', '=', projectId)
    .where('subtype', '=', 'email')
    .orderBy('created_at', 'desc')
    .execute()
  if (rows.length <= avant) return null
  return rows[0]?.id ?? null
}

/**
 * Ce qu'on donne à lire au communicant.
 *
 * Volontairement brut : le contenu du panneau de mise en prod, tel qu'il a été
 * approuvé, sans traduction préalable. Traduire pour le client est SON métier
 * (« tu traduis : la fiche produit s'affiche à nouveau sur mobile, jamais le
 * correctif de rendu est passé en review », `communicant.md`) — mâcher le
 * travail ici reviendrait à écrire l'email à sa place, mal.
 */
export function sujetDepuisProd(title: string, payload: Record<string, unknown>): string {
  const prod = payload.prod
  const lignes = [`Une mise en ligne vient d'être approuvée · ${title}`]

  if (typeof prod === 'object' && prod !== null) {
    const p = prod as Record<string, unknown>
    if (typeof p.step === 'string') lignes.push(`Étape : ${p.step}`)
    if (typeof p.verdict === 'string') lignes.push(`Verdict du garant : ${p.verdict}`)
    if (typeof p.changes === 'string') lignes.push(`Ce qui change :\n${p.changes}`)
  }

  lignes.push(
    '',
    "Écris au client pour lui dire ce qui est en ligne et ce que ça change pour lui. Rien de technique : il n'a pas à savoir qu'il y a eu une mise en production, seulement ce qu'il verra en ouvrant son site. S'il n'y a rien de visible pour lui dans ce qui vient d'être livré, n'écris pas.",
  )
  return lignes.join('\n')
}

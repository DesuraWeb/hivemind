import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { z } from 'zod'
import type { Database } from '../db/types'
import { type InboxItemRow, createInboxItem } from '../inbox/repo'
import {
  GMAIL_DRAFT_MCP_SERVER,
  type GmailDraftPort,
  type GmailSendPort,
  type GmailSentRef,
  HumanSendApproval,
  assertDraftOnlyGmailPolicy,
} from '../integrations/gmail'
import { appendMessage } from '../loop/bus'
import type { SendOptions } from '../runtime/types'

/**
 * Le chemin d'un email client, de la rédaction à l'envoi (Task 5, Phase 5).
 *
 * Deux fonctions, deux appelants qui n'ont rien en commun :
 *
 * - `submitClientEmailDraft` est ce que l'outil MCP du communicant appelle.
 *   Elle crée le brouillon chez Gmail et lève l'item d'inbox de validation
 *   dans le même geste : il n'existe aucun moyen de créer un brouillon sans
 *   qu'un humain soit sollicité, ni de solliciter sans brouillon.
 * - `sendApprovedClientEmail` est une action serveur, appelée depuis
 *   `POST /api/inbox/:id/resolve` après résolution. Elle ne prend pas de
 *   contenu en paramètre : ce qui part est le brouillon déjà relu, jamais un
 *   texte fourni à l'appel.
 *
 * Le `GmailSendPort` n'est jamais accessible depuis la première : les deux
 * fonctions reçoivent des dépendances distinctes, et le port d'envoi exige en
 * plus une `HumanSendApproval` (voir `integrations/gmail.ts`).
 */

/** Nom de l'outil exposé à l'agent. Un seul, et il ne fait rien partir. */
export const CLIENT_EMAIL_DRAFT_TOOL = 'create_draft'

/** Règle DA stricte (`docs/design/CLAUDE.md`) : le séparateur est « · ». */
const EM_DASH = '—'

const noEmDash = (label: string) =>
  ({
    check: (v: string) => !v.includes(EM_DASH),
    message: `${label} : tiret cadratin interdit, le séparateur est « · »`,
  }) as const

const subjectRule = noEmDash("l'objet")
const bodyRule = noEmDash('le corps')

/**
 * Validé côté serveur, pas seulement rappelé dans le prompt : un agent qui
 * glisse un tiret cadratin voit son appel d'outil refusé avec la raison, il ne
 * produit pas un brouillon que Florian devra corriger à la main.
 */
export const clientEmailDraftSchema = z.object({
  to: z.string().email(),
  cc: z.array(z.string().email()).optional(),
  subject: z.string().min(3).refine(subjectRule.check, subjectRule.message),
  body: z.string().min(20).refine(bodyRule.check, bodyRule.message),
})
export type ClientEmailDraftInput = z.infer<typeof clientEmailDraftSchema>

export interface ClientEmailDeps {
  db: Kysely<Database>
  /** Surface Gmail de l'agent : brouillon uniquement. */
  drafts: GmailDraftPort
  projectId: string
  /** Absent hors boucle (email rédigé à la demande, sans run en cours). */
  runId?: string
}

export interface SubmittedClientEmail {
  draftId: string
  inboxItemId: string
}

/**
 * Crée le brouillon Gmail puis l'item d'inbox `approval`/`email` qui le
 * soumet à validation.
 *
 * L'item porte le destinataire, l'objet et le corps complet : le pack DA
 * (`docs/design/data.js`, `ap-208`/`ap-211`) montre un panneau qui se décide
 * sans quitter l'inbox, et une validation qui obligerait à ouvrir Gmail pour
 * savoir ce qu'on approuve n'est pas une validation.
 *
 * Ordre volontaire : brouillon d'abord, item ensuite. L'inverse ferait
 * apparaître dans l'inbox une validation dont l'approbation échouerait faute
 * de brouillon. Si l'item échoue après la création du brouillon, il reste un
 * brouillon non annoncé dans la boîte de Florian : inerte, visible, et sans
 * personne pour l'envoyer par erreur.
 */
export async function submitClientEmailDraft(
  deps: ClientEmailDeps,
  input: ClientEmailDraftInput,
): Promise<SubmittedClientEmail> {
  const draft = clientEmailDraftSchema.parse(input)
  const ref = await deps.drafts.createDraft({
    to: draft.to,
    ...(draft.cc && draft.cc.length > 0 ? { cc: draft.cc } : {}),
    subject: draft.subject,
    body: draft.body,
  })

  const item = await createInboxItem(deps.db, {
    type: 'approval',
    subtype: 'email',
    projectId: deps.projectId,
    ...(deps.runId ? { runId: deps.runId } : {}),
    // Forme des titres du pack DA : « <objet> · brouillon prêt à envoyer ».
    title: `${draft.subject} · brouillon prêt à envoyer`,
    fromRole: 'communicant',
    payload: {
      provider: 'gmail',
      draftId: ref.draftId,
      ...(ref.threadId ? { threadId: ref.threadId } : {}),
      to: draft.to,
      ...(draft.cc && draft.cc.length > 0 ? { cc: draft.cc } : {}),
      subject: draft.subject,
      body: draft.body,
    },
  })

  if (deps.runId) {
    await appendMessage(deps.db, {
      runId: deps.runId,
      fromRole: 'communicant',
      toRole: 'system',
      kind: 'report',
      body: `Brouillon client rédigé · ${draft.to} · « ${draft.subject} ». En attente de validation humaine.`,
      meta: { inboxItemId: item.id, draftId: ref.draftId },
    })
  }

  return { draftId: ref.draftId, inboxItemId: item.id }
}

export interface ClientEmailMcpSurface {
  /** À fusionner dans `SendOptions.extraMcpServers`. */
  sendOptions: SendOptions
  /** Noms des outils réellement déclarés au serveur MCP. */
  toolNames: string[]
}

export interface ClientEmailMcpDeps extends ClientEmailDeps {
  /** `ToolPolicy.mcp` du rôle, telle que résolue en base. */
  policyMcp: readonly string[]
}

/**
 * Construit la surface MCP du communicant : un serveur in-process nommé
 * `gmail_draft`, un seul outil, `create_draft`.
 *
 * Le serveur est transporté par `SendOptions.extraMcpServers` et non par la
 * `ToolPolicy` persistée, exactement comme la sortie structurée du garant
 * (`runtime/structured.ts`) : `resolveToolPolicy` continue de poser
 * `strictMcpConfig: true` avec `mcpServers: {}`, donc les connecteurs MCP de
 * l'hôte (le Gmail personnel de Florian, entre autres) restent invisibles.
 * L'agent ne voit que ce qui est construit ici.
 *
 * `assertDraftOnlyGmailPolicy` est appelée sur ce chemin, pas dans un test :
 * si quelqu'un ajoute `gmail_send` à la liste `mcp` du rôle, la construction
 * de la surface échoue avant le premier échange.
 */
export function createClientEmailMcpSurface(deps: ClientEmailMcpDeps): ClientEmailMcpSurface {
  assertDraftOnlyGmailPolicy(deps.policyMcp)

  const draftTool = tool(
    CLIENT_EMAIL_DRAFT_TOOL,
    'Crée un BROUILLON d’email client dans la boîte de Florian et le soumet à sa validation. ' +
      'Aucun envoi : le brouillon ne part que si un humain l’approuve depuis son inbox.',
    clientEmailDraftSchema.shape,
    async (args) => {
      const { inboxItemId } = await submitClientEmailDraft(deps, args)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Brouillon créé et soumis à validation humaine (item ${inboxItemId}). Tu n'as rien d'autre à faire : l'envoi ne t'appartient pas.`,
          },
        ],
      }
    },
  )

  const tools = [draftTool]
  const server = createSdkMcpServer({ name: GMAIL_DRAFT_MCP_SERVER, tools })

  return {
    sendOptions: {
      extraMcpServers: { [GMAIL_DRAFT_MCP_SERVER]: server },
      extraAllowedTools: tools.map((t) => `mcp__${GMAIL_DRAFT_MCP_SERVER}__${t.name}`),
    },
    toolNames: tools.map((t) => t.name),
  }
}

/**
 * Action serveur déclenchée après résolution d'un item d'inbox.
 *
 * Rend `null` sans rien envoyer pour tout item qui n'est pas une approbation
 * d'email, et pour une approbation refusée : un refus laisse le brouillon en
 * place dans Gmail, il n'est ni envoyé ni supprimé. Effacer le travail d'un
 * agent parce qu'un humain a dit « pas maintenant » serait une décision que
 * personne n'a prise.
 *
 * L'autorisation elle-même n'est pas décidée ici : elle est construite par
 * `HumanSendApproval.fromResolvedInboxItem`, seule à savoir la fabriquer, à
 * partir de l'item relu.
 */
export async function sendApprovedClientEmail(
  db: Kysely<Database>,
  sender: GmailSendPort,
  item: InboxItemRow,
): Promise<GmailSentRef | null> {
  if (item.type !== 'approval' || item.subtype !== 'email') return null
  if (item.humanResponse?.approved !== true) return null

  const approval = HumanSendApproval.fromResolvedInboxItem({
    id: item.id,
    type: item.type,
    subtype: item.subtype,
    status: item.status,
    humanResponse: item.humanResponse,
    payload: item.payload,
  })

  const ref = await sender.sendDraft(approval)

  // Trace dans l'item lui-même : sans elle, rien ne distingue un item approuvé
  // dont l'email est parti d'un item approuvé dont l'envoi a échoué.
  const sent = {
    sent: {
      at: new Date().toISOString(),
      approvedAt: approval.approvedAtIso(),
      messageId: ref.messageId,
      ...(ref.threadId ? { threadId: ref.threadId } : {}),
    },
  }
  await db
    .updateTable('inbox_items')
    .set({ payload: sql`payload || ${JSON.stringify(sent)}::jsonb` })
    .where('id', '=', item.id)
    .execute()

  if (item.runId) {
    await appendMessage(db, {
      runId: item.runId,
      fromRole: 'system',
      toRole: 'communicant',
      kind: 'info',
      body: `Email client envoyé après validation humaine · brouillon ${approval.draftId}.`,
      meta: { inboxItemId: item.id, messageId: ref.messageId },
    })
  }

  return ref
}

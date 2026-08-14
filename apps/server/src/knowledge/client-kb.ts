import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { type getClient, listClients } from '../clients/repo'
import type { Database } from '../db/types'
import type { SendOptions } from '../runtime/types'

/**
 * `client_kb` : la fiche client, consultable par un agent.
 *
 * ## Le trou que ça bouche, et il était sérieux
 *
 * Trois prompts de rôles donnent pour consigne d'appeler cet outil :
 *
 * - `garant.md` : « Avant de poser une question, consulte la fiche client
 *   (`client_kb.lookup`) »
 * - `dev.md` : « Avant toute question, consulte la fiche client »
 * - `communicant.md` : « **Ton premier geste, toujours**, est
 *   `client_kb.lookup` sur le client du projet »
 *
 * `client_kb` figure dans la `ToolPolicy` de ces trois rôles depuis le premier
 * seed. Mais `resolveToolPolicy` pose systématiquement `mcpServers: {}` — et
 * aucun serveur de ce nom n'était jamais fourni. **L'outil n'a jamais
 * existé.** Les agents recevaient une consigne impossible à suivre, et le
 * mécanisme censé éviter les questions redondantes n'a jamais tourné : chaque
 * run repose des questions dont la réponse est déjà dans la fiche.
 *
 * Trouvé en écrivant la page « Protocole agents », en confrontant le pack au
 * code — pas par un test, parce qu'aucun test ne pouvait le voir : un agent
 * qui ne trouve pas un outil ne plante pas, il s'en passe.
 *
 * ## Lecture seule, et c'est structurel
 *
 * Aucun outil d'écriture ici. Une fiche client s'enrichit par les réponses
 * humaines dans l'inbox (`clients.notes`, alimenté à la résolution d'une
 * question), jamais par un agent qui déciderait tout seul de ce qui est vrai
 * d'un client. Le savoir passe par une validation humaine : c'est le cycle
 * décrit par la conscience collective, et c'est ce qui fait sa valeur.
 *
 * ## Aucun secret ne sort
 *
 * `clients/repo.ts` ne rend que les NOMS des accès détenus, jamais leurs
 * valeurs — même garantie que pour l'API HTTP, et pour la même raison. Un
 * agent qui pourrait lire un mot de passe SSH dans une fiche client n'aurait
 * plus besoin de coffre.
 */

export const CLIENT_KB_MCP_SERVER = 'client_kb'
export const CLIENT_KB_LOOKUP_TOOL = 'lookup'

/**
 * Vérifie que la politique du rôle ne réclame pas d'écriture sur la base de
 * connaissances. Appelée sur le chemin de production, pas seulement en test :
 * si quelqu'un ajoute `client_kb_write` à un rôle demain, la construction de
 * la surface échoue avant le premier échange — même garde que
 * `assertDraftOnlyGmailPolicy`.
 */
export function assertReadOnlyKbPolicy(mcp: readonly string[]): void {
  const writers = mcp.filter((name) => name !== CLIENT_KB_MCP_SERVER && name.includes('client_kb'))
  if (writers.length > 0) {
    throw new Error(
      `politique invalide : ${writers.join(', ')} — la fiche client est en lecture seule, elle s’enrichit par les réponses humaines en inbox, jamais par un agent.`,
    )
  }
}

const lookupSchema = z.object({
  /**
   * Nom du client, ou fragment. Le projet ne suffit pas : un agent ne connaît
   * pas toujours l'identifiant de la fiche, mais il connaît le nom qu'on lui a
   * donné dans son cadrage.
   */
  client: z.string().min(1).describe('Nom du client, ou fragment de nom.'),
})

export interface ClientKbSurface {
  /** À fusionner dans `SendOptions.extraMcpServers`. */
  sendOptions: SendOptions
  toolNames: string[]
}

export interface ClientKbDeps {
  db: Kysely<Database>
  /** La politique d'outils du rôle, telle que résolue en base (forme jsonb, non garantie). */
  tools: unknown
}

/** Rend la fiche en texte : c'est ce que lit un modèle, et une phrase coûte moins qu'un objet. */
function render(client: Awaited<ReturnType<typeof getClient>>): string {
  if (!client) return ''
  const lines = [`# ${client.name}`]
  if (client.siret) lines.push(`SIRET : ${client.siret}`)
  if (client.tone) lines.push(`\n## Ton de communication (fait foi)\n${client.tone}`)

  if (client.contacts.length > 0) {
    lines.push('\n## Contacts')
    for (const c of client.contacts) {
      const parts = [c.name, c.role, c.email, c.phone].filter(Boolean)
      if (parts.length > 0) lines.push(`- ${parts.join(' · ')}`)
    }
  }

  if (client.knowledge.length > 0) {
    lines.push('\n## Ce qui a déjà été répondu')
    for (const k of client.knowledge) {
      lines.push(`- ${k.question}\n  → ${k.answer}`)
    }
  } else {
    lines.push('\n## Ce qui a déjà été répondu\nRien pour ce client à ce jour.')
  }

  if (client.accessKeys.length > 0) {
    // Les NOMS seulement. Un agent doit savoir qu'un accès existe pour ne pas
    // le redemander ; il n'a aucune raison de pouvoir le lire.
    lines.push(
      `\n## Accès détenus (dans le coffre, valeurs non consultables)\n${client.accessKeys.join(' · ')}`,
    )
  }

  return lines.join('\n')
}

export function createClientKbSurface(deps: ClientKbDeps): ClientKbSurface {
  assertReadOnlyKbPolicy(readPolicyMcp(deps.tools))

  const lookup = tool(
    CLIENT_KB_LOOKUP_TOOL,
    'Consulte la fiche d’un client : son ton de communication, ses contacts, et surtout ' +
      'ce qui lui a DÉJÀ été demandé et répondu. À appeler avant de poser une question ' +
      'à un humain : la réponse y est peut-être déjà.',
    lookupSchema.shape,
    async (args) => {
      const all = await listClients(deps.db)
      const needle = args.client.trim().toLowerCase()
      const found =
        all.find((c) => c.name.toLowerCase() === needle) ??
        all.find((c) => c.name.toLowerCase().includes(needle))

      if (!found) {
        // Dire qu'on ne sait pas, plutôt que de rendre une fiche vide qui
        // ferait croire à un client sans historique.
        return {
          content: [
            {
              type: 'text' as const,
              text: `Aucune fiche pour « ${args.client} ». Ce n'est pas un client sans historique : c'est un client sans fiche. Si tu as besoin d'une information à son sujet, pose la question.`,
            },
          ],
        }
      }

      return { content: [{ type: 'text' as const, text: render(found) }] }
    },
  )

  const tools = [lookup]
  const server = createSdkMcpServer({ name: CLIENT_KB_MCP_SERVER, tools })

  return {
    sendOptions: {
      extraMcpServers: { [CLIENT_KB_MCP_SERVER]: server },
      extraAllowedTools: tools.map((t) => `mcp__${CLIENT_KB_MCP_SERVER}__${t.name}`),
    },
    toolNames: tools.map((t) => t.name),
  }
}

/**
 * Extrait la liste `mcp` d'une politique d'outils lue en base.
 *
 * `ResolvedRole.tools` est typé `Record<string, unknown>` (`loop/roles.ts`,
 * fichier protégé par le 4ᵉ gate : on ne le retype pas au passage). La colonne
 * est du jsonb, sa forme n'est garantie par personne — une politique mal
 * écrite doit donner « aucun serveur MCP », jamais faire tomber un run.
 */
export function readPolicyMcp(tools: unknown): string[] {
  if (typeof tools !== 'object' || tools === null) return []
  const raw = (tools as { mcp?: unknown }).mcp
  if (!Array.isArray(raw)) return []
  return raw.filter((name): name is string => typeof name === 'string')
}

/** Vrai quand le rôle a `client_kb` dans sa politique : inutile de construire la surface sinon. */
export function roleUsesClientKb(tools: unknown): boolean {
  return readPolicyMcp(tools).includes(CLIENT_KB_MCP_SERVER)
}

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readPolicyMcp } from '../knowledge/client-kb'
import type { SendOptions } from '../runtime/types'
import { rendre } from './operations'
import type { OpsExecutor, Serveur } from './types'

/**
 * `ops_read` : la seule surface que le rôle `ops` touche, et elle ne fait que
 * LIRE.
 *
 * Un outil. Il lit un fichier de configuration sur le serveur distant, en
 * passant par l'opération `lire_fichier` du catalogue borné — pas par un
 * chemin parallèle. La conséquence est que le chemin subit exactement la même
 * validation que dans un plan : absolu, sans remontée de répertoire.
 *
 * ## Pourquoi la lecture est une exception justifiée
 *
 * Tout le reste passe par un plan inerte que le serveur traduit. La lecture,
 * elle, doit être immédiate : un agent qui ne peut pas lire le `php.ini`
 * actuel ne peut que supposer ce qu'il contient — et un plan bâti sur des
 * suppositions est exactement ce que le prompt lui interdit de rendre.
 *
 * Lire ne change rien, ne se défait pas (il n'y a rien à défaire), et
 * n'atteint aucun secret que le coffre protégerait : les credentials du
 * serveur ne sont pas SUR le serveur.
 *
 * ## Ce qu'on refuse ici, et qui se voit dans les noms
 *
 * Aucun outil d'écriture, aucun outil d'exécution, aucun outil de
 * rechargement. Un rôle qui pourrait recharger nginx pourrait faire tomber un
 * site sans passer par la moindre validation.
 */

export const OPS_READ_MCP_SERVER = 'ops_read'
export const OPS_READ_TOOL = 'lire_config'

/**
 * Refuse toute entrée MCP d'exploitation autre que la lecture.
 *
 * Appelée sur le chemin de production, pas seulement en test : si quelqu'un
 * ajoute `ops_write` ou `ops_exec` à la politique du rôle, la construction de
 * la surface échoue avant le premier échange. Même garde que
 * `assertDraftOnlyGmailPolicy` pour Gmail.
 */
export function assertReadOnlyOpsPolicy(mcp: readonly string[]): void {
  const offenders = mcp.filter((n) => n.startsWith('ops') && n !== OPS_READ_MCP_SERVER)
  if (offenders.length > 0) {
    throw new Error(
      `politique invalide : ${offenders.join(', ')} — le rôle ops ne dispose que de la LECTURE (${OPS_READ_MCP_SERVER}). Ce qui modifie un serveur passe par un plan validé, jamais par un outil.`,
    )
  }
}

const lireSchema = z.object({
  chemin: z
    .string()
    .min(1)
    .describe('Chemin absolu du fichier de configuration à lire, ex. /etc/php/8.2/fpm/php.ini'),
})

export interface OpsReadDeps {
  executor: OpsExecutor
  serveur: Serveur
  /** La politique du rôle, telle que résolue en base (forme jsonb, non garantie). */
  tools: unknown
  /** Taille max rendue au modèle. Un fichier de 40 Mo n'apprend rien de plus qu'un extrait. */
  maxOctets?: number
}

export interface OpsReadSurface {
  sendOptions: SendOptions
  toolNames: string[]
}

const MAX_OCTETS_DEFAUT = 64 * 1024

export function createOpsReadSurface(deps: OpsReadDeps): OpsReadSurface {
  assertReadOnlyOpsPolicy(readPolicyMcp(deps.tools))

  const lire = tool(
    OPS_READ_TOOL,
    'Lit un fichier de configuration sur le serveur. Lecture seule : rien de ce que tu ' +
      'fais avec cet outil ne modifie quoi que ce soit. À utiliser AVANT de proposer un ' +
      'plan, pour constater au lieu de supposer.',
    lireSchema.shape,
    async (args) => {
      // Passe par le catalogue, pas par un chemin parallèle : le chemin subit
      // donc la même validation (absolu, sans remontée) que dans un plan.
      let commande: string
      try {
        commande = rendre({ nom: 'lire_fichier', params: { chemin: args.chemin } }).commande
      } catch (err) {
        return texte(
          `Chemin refusé : ${err instanceof Error ? err.message : String(err)}. Un chemin doit être absolu et ne pas remonter de répertoire.`,
        )
      }

      const { code, stdout, stderr } = await deps.executor.executer(deps.serveur, commande)
      if (code !== 0) {
        // Dire l'échec plutôt que rendre un contenu vide : un fichier absent
        // et un fichier vide ne mènent pas au même plan.
        return texte(
          `Lecture impossible de ${args.chemin} (code ${code}) : ${stderr.trim() || 'aucune sortie d’erreur'}. Ne suppose pas son contenu — dis que tu ne l’as pas lu.`,
        )
      }

      const max = deps.maxOctets ?? MAX_OCTETS_DEFAUT
      if (stdout.length > max) {
        return texte(
          `${stdout.slice(0, max)}\n\n[…] Fichier tronqué à ${max} octets. Ce qui suit n’a pas été lu : ne le suppose pas.`,
        )
      }
      return texte(stdout)
    },
  )

  const tools = [lire]
  const server = createSdkMcpServer({ name: OPS_READ_MCP_SERVER, tools })

  return {
    sendOptions: {
      extraMcpServers: { [OPS_READ_MCP_SERVER]: server },
      extraAllowedTools: tools.map((t) => `mcp__${OPS_READ_MCP_SERVER}__${t.name}`),
    },
    toolNames: tools.map((t) => t.name),
  }
}

function texte(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

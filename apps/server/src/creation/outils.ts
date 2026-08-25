import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import type { SendOptions } from '../runtime/types'
import { type RetoucheFiche, retoucheFicheSchema } from './fiche'

/**
 * `creation` : la surface de l'assistant de création d'orbe.
 *
 * Deux outils au lot 1. Un pour comprendre le parc, un pour remplir l'écran.
 * Les outils de vérification (`verifier_depot`, `sonder_url`) et de création
 * (`creer_orbe`, `creer_projet`) arrivent au lot 2 — vérifier est ce qui rend
 * l'écriture sûre, les deux vont ensemble.
 *
 * ## `proposer_fiche` n'écrit rien en base
 *
 * Il repose une retouche dans un tampon que l'appelant relit après le tour.
 * C'est délibéré : au lot 1 Hive REMPLIT l'écran et ne crée rien, donc aucun
 * outil de cette surface ne doit pouvoir toucher une table de domaine. Le
 * jour où `creer_projet` arrive, il n'acceptera que ce qui est passé par ici —
 * garantissant que Florian a vu se remplir ce qui part en base.
 */

export const CREATION_MCP_SERVER = 'creation'

/** Combien d'éléments par famille dans le contexte. Au-delà, ça coûte plus que ça n'aide. */
const MAX_PAR_FAMILLE = 25

export interface SurfaceCreationDeps {
  db: Kysely<Database>
}

export interface SurfaceCreation {
  sendOptions: SendOptions
  /**
   * Les retouches émises pendant le tour, dans l'ordre d'émission.
   *
   * Un tableau et pas une seule valeur : Hive apprend souvent deux choses dans
   * le même tour (le nom, puis le découpage qu'il en déduit) et les émet
   * séparément. Garder la dernière seule perdrait la première.
   */
  retouches: RetoucheFiche[]
  toolNames: string[]
}

function texte(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function createSurfaceCreation(deps: SurfaceCreationDeps): SurfaceCreation {
  const retouches: RetoucheFiche[] = []

  const proposer = tool(
    'proposer_fiche',
    [
      "Remplit l'écran de création avec ce que tu viens d'apprendre.",
      "N'envoie QUE les champs que tu viens d'apprendre ou de corriger : un champ absent garde sa valeur.",
      "Appelle-le dès que tu apprends quelque chose, sans attendre d'avoir tout compris — l'écran se remplit pendant que vous discutez.",
      "N'invente jamais une valeur que Florian ne t'a pas donnée ou que tu n'as pas déduite avec lui. S'il te manque le dépôt, redemande-le.",
    ].join(' '),
    retoucheFicheSchema.shape,
    async (args) => {
      // Revalidé ici et pas seulement déclaré : le schéma passé au SDK décrit
      // la forme attendue, il ne garantit pas ce qui arrive. Un `parse` rend
      // l'erreur au modèle, qui corrige, au lieu de laisser une fiche à moitié
      // typée descendre jusqu'à l'écran.
      const parsed = retoucheFicheSchema.safeParse(args)
      if (!parsed.success) {
        return texte(
          `Fiche refusée : ${parsed.error.issues.map((i) => `${i.path.join('.')} · ${i.message}`).join(' ; ')}. Corrige et rappelle l'outil.`,
        )
      }
      retouches.push(parsed.data)
      return texte("Écran mis à jour. Continue la conversation, n'annonce pas l'outil.")
    },
  )

  const contexte = tool(
    'lire_contexte',
    [
      'Ce que Silithid sait déjà : les orbes existantes, les fiches client, les préférences transverses de Florian, et les stacks de ses projets passés.',
      "Appelle-le AVANT de proposer une stack ou un découpage, pour t'appuyer sur ce qui existe au lieu de repartir de zéro.",
    ].join(' '),
    {},
    async () => {
      const [orbes, clients, prefs, projets] = await Promise.all([
        deps.db
          .selectFrom('globes')
          .select(['slug', 'name'])
          .orderBy('position')
          .limit(MAX_PAR_FAMILLE)
          .execute(),
        deps.db
          .selectFrom('clients')
          .select(['id', 'name'])
          .orderBy('name')
          .limit(MAX_PAR_FAMILLE)
          .execute(),
        // Cercle `hive` seulement : les arbitrages transverses de Florian. Les
        // savoirs d'un projet ou d'un client ne regardent pas la création d'un
        // autre projet, et les envoyer coûterait des jetons pour du hors-sujet.
        deps.db
          .selectFrom('savoirs')
          .select(['sujet', 'contenu'])
          .where('cercle', '=', 'hive')
          .where('etat', '=', 'actif')
          .orderBy('rappels', 'desc')
          .limit(MAX_PAR_FAMILLE)
          .execute(),
        deps.db
          .selectFrom('projects')
          .select(['name', 'stack'])
          .where('stack', 'is not', null)
          .orderBy('created_at', 'desc')
          .limit(MAX_PAR_FAMILLE)
          .execute(),
      ])

      const bloc = (titre: string, lignes: string[]) =>
        lignes.length > 0 ? `## ${titre}\n${lignes.join('\n')}` : `## ${titre}\naucun`

      return texte(
        [
          bloc(
            'Orbes',
            orbes.map((o) => `- ${o.name} (slug \`${o.slug}\`)`),
          ),
          bloc(
            'Fiches client',
            clients.map((c) => `- ${c.name} · id \`${c.id}\``),
          ),
          bloc(
            'Préférences de Florian',
            prefs.map((p) => `- **${p.sujet}** · ${p.contenu}`),
          ),
          bloc(
            'Stacks déjà utilisées',
            projets.map((p) => `- ${p.name} · ${p.stack}`),
          ),
        ].join('\n\n'),
      )
    },
  )

  const tools = [proposer, contexte]
  const server = createSdkMcpServer({ name: CREATION_MCP_SERVER, tools })

  return {
    sendOptions: {
      extraMcpServers: { [CREATION_MCP_SERVER]: server },
      extraAllowedTools: tools.map((t) => `mcp__${CREATION_MCP_SERVER}__${t.name}`),
    },
    retouches,
    toolNames: tools.map((t) => t.name),
  }
}

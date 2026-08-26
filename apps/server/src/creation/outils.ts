import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from '../db/types'
import { createGlobe } from '../globes/repo'
import type { SondeHttp } from '../ops/types'
import { RosterInvalideError, UnknownGlobeError, createProject } from '../projects/create'
import type { SendOptions } from '../runtime/types'
import { type Fiche, appliquerRetouche, manquesFiche, retoucheFicheSchema } from './fiche'

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
  http: SondeHttp
  /** La fiche telle qu'elle est affichée au début du tour. */
  ficheInitiale: Fiche
}

export interface SurfaceCreation {
  sendOptions: SendOptions
  /**
   * La fiche à la fin du tour : l'initiale, plus toutes les retouches émises.
   *
   * La surface la porte plutôt que d'accumuler des retouches à part, parce que
   * les outils de création lisent CETTE fiche — c'est ce qui garantit que Hive
   * ne peut créer que ce qui est à l'écran. Ils n'ont aucun paramètre de
   * contenu : il n'y a rien à inventer hors bande.
   */
  fiche: () => Fiche
  /** Ce que ce tour a réellement écrit en base. */
  creations: () => { globeId: string | null; projectId: string | null }
  toolNames: string[]
}

function texte(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function createSurfaceCreation(deps: SurfaceCreationDeps): SurfaceCreation {
  let fiche: Fiche = deps.ficheInitiale
  let globeId: string | null = null
  let projectId: string | null = null

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
      fiche = appliquerRetouche(fiche, parsed.data)
      const manques = manquesFiche(fiche)
      return texte(
        manques.length > 0
          ? `Écran mis à jour. Il manque encore : ${manques.join(', ')}. Continue la conversation, n'annonce pas l'outil.`
          : "Écran mis à jour, la fiche est complète. Continue la conversation, n'annonce pas l'outil.",
      )
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

  const sonder = tool(
    'sonder_url',
    "Vérifie qu'une URL répond. Sers-t'en pour le staging avant de l'inscrire dans la fiche.",
    { url: z.string().url() },
    async (args) => {
      const r = await deps.http(args.url)
      if ('erreur' in r) return texte(`${args.url} ne répond pas · ${r.erreur}`)
      return texte(`${args.url} répond · HTTP ${r.statut}`)
    },
  )

  const verifier = tool(
    'verifier_depot',
    "Vérifie qu'un dépôt GitHub `proprietaire/nom` est atteignable, avant de l'inscrire dans la fiche.",
    { depot: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'attendu : proprietaire/nom') },
    async (args) => {
      const r = await deps.http(`https://github.com/${args.depot}`)
      if ('erreur' in r)
        return texte(`Impossible de joindre GitHub · ${r.erreur}. Ne conclus rien.`)
      if (r.statut >= 200 && r.statut < 400) return texte(`${args.depot} existe et est public.`)
      // Le point à ne surtout pas déformer : cette sonde est ANONYME. Un dépôt
      // privé rend 404 exactement comme un dépôt inexistant. Annoncer « ce
      // dépôt n'existe pas » sur un 404 serait faux une fois sur deux, et
      // enverrait Florian corriger un nom qui était bon.
      if (r.statut === 404) {
        return texte(
          `${args.depot} rend 404 pour une requête anonyme. Ça veut dire « inexistant » OU « privé » — la sonde ne peut pas les distinguer. Demande à Florian, ne tranche pas.`,
        )
      }
      return texte(`${args.depot} rend HTTP ${r.statut}. Ne conclus rien de définitif.`)
    },
  )

  const creerOrbe = tool(
    'creer_orbe',
    "Crée l'orbe décrite dans la fiche. Aucun paramètre : ce qui est à l'écran fait foi.",
    {},
    async () => {
      const orbe = fiche.orbeACreer
      if (!orbe?.nom?.trim()) {
        return texte(
          "Aucune orbe à créer dans la fiche. Appelle d'abord `proposer_fiche` avec `orbeACreer`.",
        )
      }
      if (globeId) return texte('Cette orbe a déjà été créée pendant cette conversation.')

      const cree = await createGlobe(
        deps.db,
        orbe.couleur ? { name: orbe.nom, color: orbe.couleur } : { name: orbe.nom },
      )
      globeId = cree.id
      // La fiche bascule sur l'orbe créée : le projet devra s'y poser, et sans
      // ça `manquesFiche` réclamerait encore « l'orbe d'accueil ».
      fiche = appliquerRetouche(fiche, { orbeACreer: null, projet: { orbe: cree.id } })
      return texte(`Orbe « ${cree.name} » créée.`)
    },
  )

  const creerProjet = tool(
    'creer_projet',
    "Crée le projet décrit dans la fiche, avec ses steps, son roster et sa mémoire. Aucun paramètre : ce qui est à l'écran fait foi.",
    {},
    async () => {
      if (projectId) return texte('Ce projet a déjà été créé pendant cette conversation.')
      const manques = manquesFiche(fiche)
      if (manques.length > 0) {
        return texte(`Fiche incomplète, rien n'a été créé. Il manque : ${manques.join(', ')}.`)
      }
      const p = fiche.projet ?? {}

      try {
        const cree = await createProject(deps.db, {
          globeSlug: p.orbe as string,
          name: p.nom as string,
          repoFullName: p.depot as string,
          ...(p.clientId ? { clientId: p.clientId } : {}),
          ...(p.stack ? { stack: p.stack } : {}),
          ...(p.staging ? { stagingUrl: p.staging } : {}),
          ...(p.jugeVisuel !== undefined ? { jugeVisuel: p.jugeVisuel } : {}),
          ...(p.demarrage ? { demarrage: p.demarrage.ou } : {}),
          ...(p.demarrage?.domaine ? { domaine: p.demarrage.domaine } : {}),
          steps: (fiche.steps ?? []).map((st) => ({
            title: st.titre,
            specs: st.specs,
            autonomy: st.auto ? ('auto' as const) : null,
            ...(st.iterations ? { maxIterations: st.iterations } : {}),
          })),
          ...(fiche.roster
            ? {
                roster: fiche.roster.map((r) => ({
                  key: r.key,
                  ...(r.enabled !== undefined ? { enabled: r.enabled } : {}),
                  ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}),
                })),
              }
            : {}),
          ...(fiche.savoirs
            ? {
                savoirs: fiche.savoirs.map((sv) => ({
                  cercle: sv.cercle,
                  sujet: sv.sujet,
                  contenu: sv.contenu,
                  ...(sv.stack !== undefined ? { stack: sv.stack } : {}),
                  ...(sv.domaine !== undefined ? { domaine: sv.domaine } : {}),
                })),
              }
            : {}),
        })
        projectId = cree.id
        return texte(
          `Projet « ${cree.name} » créé dans l'orbe \`${cree.globeSlug}\` avec ${cree.stepCount} step(s). Dis-le à Florian.`,
        )
      } catch (err) {
        // Rendre la cause au modèle plutôt que de lever : il peut corriger la
        // fiche et réessayer dans le même tour. Une exception ici remonterait
        // en panne générique et perdrait le motif exact du refus.
        if (err instanceof RosterInvalideError || err instanceof UnknownGlobeError) {
          return texte(`Refusé, rien n'a été créé · ${err.message}`)
        }
        throw err
      }
    },
  )

  const tools = [proposer, contexte, sonder, verifier, creerOrbe, creerProjet]
  const server = createSdkMcpServer({ name: CREATION_MCP_SERVER, tools })

  return {
    sendOptions: {
      extraMcpServers: { [CREATION_MCP_SERVER]: server },
      extraAllowedTools: tools.map((t) => `mcp__${CREATION_MCP_SERVER}__${t.name}`),
    },
    fiche: () => fiche,
    creations: () => ({ globeId, projectId }),
    toolNames: tools.map((t) => t.name),
  }
}

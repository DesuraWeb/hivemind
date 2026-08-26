import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import type { InboxItemRow } from '../inbox/repo'
import { proposerSavoirs } from '../knowledge/propose'
import type { CandidatSavoir } from '../runtime/structured'
import type { ResultatApplication } from './apply'
import type { RapportProvision } from './provision'

/**
 * Ce que les déploiements apprennent (Phase 6, Task 7 · la boucle qui remplit).
 *
 * Arbitrage de Florian, 14/08 : « le premier déploiement d'un site Astro ne
 * doit pas être le même que le 15ᵉ ». La structure de destination existait
 * depuis `ops/recipes.ts` ; ce fichier est ce qui la remplit.
 *
 * ## Les trois sources, et pourquoi ce sont celles-là
 *
 * 1. **Ce que le juge a trouvé.** Un écart constaté après un provisioning est
 *    une chose qu'on aurait dû faire et qu'on n'a pas faite. C'est la
 *    définition même d'un rappel.
 * 2. **Ce que Florian a corrigé en validant.** Un plan refusé, ou approuvé
 *    avec une note, porte un arbitrage qu'aucun agent n'aurait deviné.
 * 3. **Ce qui a cassé après coup.** Une opération qui échoue sur une stack
 *    échouera encore sur la suivante — et c'est le seul des trois signaux qui
 *    vient du serveur lui-même, pas d'un jugement.
 *
 * ## Ce qui remonte est du TEXTE, jamais une opération
 *
 * Tout ce que ce fichier produit atterrit dans les `rappels` d'une recette :
 * des phrases qu'un agent lit avant de proposer un plan. **Aucune étape
 * n'est jamais ajoutée ici**, et c'est la ligne de toute la phase — une étape
 * s'exécute en champ libre sur le prochain serveur vierge, donc l'ajouter
 * automatiquement serait du pouvoir qui s'élargit sans décision humaine.
 *
 * Le savoir s'accumule tout seul ; le pouvoir ne s'élargit que par une
 * décision humaine.
 *
 * ## Et pourtant, chaque savoir passe QUAND MÊME par une validation
 *
 * « Tout seul » ne veut pas dire « sans personne ». Un rappel proposé arrive
 * en inbox comme n'importe quelle proposition de savoir (Phase 7) : même
 * empreinte anti-répétition, même détection de conflit, même archivage de la
 * formulation de Florian plutôt que celle de l'agent. Ce qui est automatique,
 * c'est la TROUVAILLE, pas l'entrée en mémoire.
 *
 * Réutiliser `proposerSavoirs` plutôt qu'écrire un second chemin est
 * délibéré : deux chemins de proposition, ce sont deux détections de conflit à
 * garder cohérentes, et un jour où l'une des deux oublie une règle.
 */

/** Bornée : trois rappels par déploiement suffisent, au-delà c'est du résumé. */
const MAX_CANDIDATS = 3

/** Un sujet doit rester court et nominal — c'est la clé de détection de conflit. */
function sujet(prefixe: string, texte: string): string {
  const plat = texte.trim().replace(/\s+/g, ' ')
  const coupe = plat.length > 60 ? `${plat.slice(0, 59).trimEnd()}…` : plat
  return `${prefixe} · ${coupe}`.slice(0, 80)
}

export interface ApprendreDeps {
  db: Kysely<Database>
  projectId: string
  /** La stack visée. Sans elle, le savoir n'atteindrait aucune recette. */
  stack: string | null
  /**
   * Le NIVEAU auquel ce qu'on apprend est vrai : un hébergeur nommé
   * (`planethoster`), un type d'hébergement (`mutualise`), ou absent quand ça
   * vaut partout (migration 0016).
   *
   * Absent était le seul comportement possible avant la cascade, et tous les
   * savoirs appris atterrissaient donc au niveau le plus général. « Monter PHP
   * chez PlanetHoster » y était rappelé sur un VPS, où il n'y a aucun PHP.
   */
  hebergement?: string | null
  runId?: string | null
}

/**
 * Source 1 · ce que le juge a trouvé.
 *
 * Seuls les écarts BLOQUANTS et MAJEURS remontent. Un écart mineur constaté
 * une fois n'est pas une leçon, c'est une observation — et remonter chaque
 * détail transformerait la revue du matin en liste de courses.
 *
 * La preuve est reprise dans le contenu : un rappel qui dit « penser au
 * robots.txt » sans dire comment on a su qu'il manquait est un rappel qu'on ne
 * peut pas contester dans six mois.
 */
export async function apprendreDuJuge(
  deps: ApprendreDeps,
  rapport: RapportProvision,
): Promise<number> {
  const retenus = rapport.ecarts.filter((e) => e.severite === 'bloquant' || e.severite === 'majeur')
  if (retenus.length === 0 || !deps.stack) return 0

  const candidats: CandidatSavoir[] = retenus.slice(0, MAX_CANDIDATS).map((e) => ({
    sujet: sujet('déploiement', e.constat),
    contenu: `${e.constat}\n\nConstaté après un provisioning · ${e.preuve}. À vérifier avant de conclure le prochain déploiement sur cette stack.`,
    cercle: 'hive',
    stack: deps.stack as string,
  }))

  return proposer(deps, candidats)
}

/**
 * Source 2 · ce que Florian a corrigé en validant.
 *
 * Ne remonte QUE s'il a écrit quelque chose. Un refus sec ne porte aucune
 * leçon — il dit « non », pas « non parce que ». Et un « oui » silencieux non
 * plus : c'est le cas normal, et en tirer un savoir remplirait la mémoire de
 * confirmations sans contenu.
 *
 * Le refus motivé est le signal le plus précieux des trois : c'est un
 * arbitrage humain qu'aucun agent n'aurait deviné, et sans cette source il
 * faudrait le redonner à chaque déploiement.
 */
export async function apprendreDuRetour(deps: ApprendreDeps, item: InboxItemRow): Promise<number> {
  const reponse = item.humanResponse
  const texte = typeof reponse?.text === 'string' ? reponse.text.trim() : ''
  if (texte.length < 15 || !deps.stack) return 0

  const approuve = reponse?.approved === true
  const candidats: CandidatSavoir[] = [
    {
      sujet: sujet('arbitrage', texte),
      contenu: `${texte}\n\nArbitrage humain sur un plan d'exploitation ${
        approuve ? 'approuvé' : 'refusé'
      } · ${item.title}. À lire avant de proposer un plan sur cette stack.`,
      cercle: 'hive',
      stack: deps.stack,
    },
  ]

  return proposer(deps, candidats)
}

/**
 * Source 3 · ce qui a cassé après coup.
 *
 * Le seul des trois signaux qui vient du serveur lui-même et non d'un
 * jugement. Une opération qui échoue sur une stack échouera encore sur la
 * suivante, et la sortie d'erreur dit souvent exactement pourquoi — un paquet
 * qui manque, un service qui n'existe pas sous ce nom, un chemin qui n'est pas
 * là où on le croyait.
 *
 * Un seul candidat, celui de l'opération qui a échoué : les suivantes n'ont
 * jamais été tentées, il n'y a rien à apprendre d'elles.
 */
export async function apprendreDeLEchec(
  deps: ApprendreDeps,
  resultat: ResultatApplication,
): Promise<number> {
  if (resultat.ok || !resultat.echec || !deps.stack) return 0

  const rate = resultat.appliquees.at(-1)
  if (!rate) return 0

  const erreur = (resultat.echec.erreur || 'sans sortie d’erreur').split('\n')[0] ?? ''
  const candidats: CandidatSavoir[] = [
    {
      sujet: sujet('échec', `${rate.nom} · ${erreur}`),
      contenu: `L'opération « ${rate.resume} » a échoué : ${erreur}\n\nCommande : ${rate.commande.split('\n')[0]}\n\nÀ anticiper sur cette stack plutôt que de la reproposer telle quelle.`,
      cercle: 'hive',
      stack: deps.stack,
    },
  ]

  return proposer(deps, candidats)
}

/**
 * Source 4 · ce qu'une mise en production a appris.
 *
 * Les trois sources existantes écoutent le provisioning et les demandes de
 * changement, parce que ça passe par l'agent d'exploitation. Un déploiement
 * passe par `DeployTarget` — un chemin qui n'apprenait RIEN, alors que c'est
 * exactement là que les erreurs de version se produisent.
 *
 * Seuls les ÉCHECS remontent. Un déploiement qui se passe bien n'apprend rien
 * qu'on ne sache déjà : la recette a marché, c'est son rôle. Ce qui vaut une
 * ligne, c'est une sauvegarde qui rend zéro octet, une migration qui casse sur
 * cette base-là, un site qui rend 502 après une mise en ligne pourtant réussie.
 */
export async function apprendreDuDeploiement(
  deps: ApprendreDeps,
  resultat: { ok: boolean; etapes: Array<{ nom: string; ok: boolean; detail: string }> },
): Promise<number> {
  if (resultat.ok || !deps.stack) return 0

  const rate = resultat.etapes.find((e) => !e.ok)
  if (!rate) return 0

  const candidats: CandidatSavoir[] = [
    {
      sujet: sujet('mise en prod', `${rate.nom} · ${rate.detail}`),
      contenu: [
        `L'étape « ${rate.nom} » d'une mise en production a échoué : ${rate.detail}`,
        '',
        'À anticiper au prochain déploiement de cette stack sur cet hébergement,',
        'plutôt que de le redécouvrir sur un site vivant.',
      ].join('\n'),
      cercle: 'hive',
      stack: deps.stack,
    },
  ]

  return proposer(deps, candidats)
}

/**
 * Le point d'écriture commun.
 *
 * `domaine: 'exploitation'` range le savoir dans la mémoire de l'agent ops et
 * pas dans celle du dev (migration 0012) : sans ce champ, « penser au
 * robots.txt » atterrirait dans le cadrage de chaque step de la stack, où il
 * n'apprend rien à personne.
 */
async function proposer(deps: ApprendreDeps, candidats: CandidatSavoir[]): Promise<number> {
  const { proposes } = await proposerSavoirs(deps.db, {
    runId: deps.runId ?? null,
    projectId: deps.projectId,
    // La portée est posée ICI, une fois, plutôt que sur chaque candidat de
    // chaque source : tout ce qu'un déploiement apprend est vrai au même
    // niveau, celui du serveur sur lequel il a tourné.
    candidats: deps.hebergement
      ? candidats.map((c) => ({ ...c, hebergement: deps.hebergement as string }))
      : candidats,
    fromRole: 'ops',
    domaine: 'exploitation',
  })
  return proposes.length
}

import type { Kysely } from 'kysely'
import type { CercleMemoire, Database } from '../db/types'
import { createInboxItem } from '../inbox/repo'
import { type Savoir, corriger } from './store'

/**
 * Le conflit de savoirs : quand une proposition contredit ce qu'on sait déjà.
 *
 * ## Comment on le détecte, et l'honnêteté que ça impose
 *
 * **Par sujet déclaré** (arbitrage du 15/08). Deux savoirs ACTIFS de même
 * sujet dans le MÊME cercle se contredisent probablement : le sujet est une
 * clé d'identité, deux réponses différentes à la même question ne peuvent pas
 * être vraies ensemble.
 *
 * C'est déterministe et gratuit, contre un appel de modèle par proposition.
 * **Et c'est imparfait** : deux savoirs contradictoires rangés sous des sujets
 * différents passeront entre les mailles. L'item le DIT au lieu de prétendre à
 * une certitude — un mécanisme de détection qui se présente comme exhaustif
 * fait baisser la garde de celui qui le lit, et c'est pire que pas de
 * détection du tout.
 *
 * Le filet de rattrapage est la revue de péremption : c'est là que deux
 * savoirs voisins se retrouvent côte à côte sous les yeux d'un humain.
 *
 * ## Pourquoi le même cercle seulement
 *
 * Deux cercles différents ne se contredisent JAMAIS : le rappel en cascade
 * fait déjà gagner le plus spécifique (`recall.ts`). « PHP 8.1 max » au globe
 * et « PHP 8.3 » chez un client n'est pas un conflit, c'est le mécanisme
 * nominal — et lever un item là-dessus noierait les vrais conflits sous des
 * arbitrages qui fonctionnent.
 */

export const CONFLIT_INBOX_SUBTYPE = 'savoir_conflit'

/** Normalisation du sujet : la même que `propose.ts`, sinon les deux ne recoupent pas. */
export function normaliserSujet(sujet: string): string {
  return sujet
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
}

export interface CercleCible {
  cercle: CercleMemoire
  cercleId: string | null
}

/**
 * Le savoir actif qu'une proposition contredirait, s'il existe.
 *
 * Compare sur le sujet normalisé plutôt que par égalité stricte : « Version
 * PHP » et « version php » désignent la même chose, et laisser passer un
 * doublon à cause d'une majuscule créerait exactement le désordre que cette
 * détection existe pour éviter.
 */
export async function trouverConflit(
  db: Kysely<Database>,
  cible: CercleCible,
  sujet: string,
): Promise<Savoir | null> {
  let q = db
    .selectFrom('savoirs')
    .select([
      'id',
      'racine_id',
      'version',
      'cercle',
      'cercle_id',
      'sujet',
      'contenu',
      'stack',
      'rappels',
      'created_at',
    ])
    .where('etat', '=', 'actif')
    .where('cercle', '=', cible.cercle)
  q =
    cible.cercle === 'hive'
      ? q.where('cercle_id', 'is', null)
      : q.where('cercle_id', '=', cible.cercleId ?? '')

  const cle = normaliserSujet(sujet)
  const ligne = (await q.execute()).find((l) => normaliserSujet(l.sujet) === cle)
  if (!ligne) return null

  return {
    id: ligne.id,
    racineId: ligne.racine_id,
    version: ligne.version,
    cercle: ligne.cercle,
    cercleId: ligne.cercle_id,
    sujet: ligne.sujet,
    contenu: ligne.contenu,
    stack: ligne.stack,
    rappels: ligne.rappels,
    createdAt: new Date(ligne.created_at as unknown as string),
  }
}

export interface LeverConflitOptions {
  existant: Savoir
  propose: { sujet: string; contenu: string }
  projectId?: string | null
  runId?: string | null
}

/**
 * Lève l'item de conflit : l'existant et la proposition côte à côte, et les
 * trois issues du pack — remplacer, garder, fusionner à la main.
 *
 * L'item porte les DEUX textes en entier. Renvoyer vers une autre page pour
 * lire l'existant obligerait à décider de mémoire, ce qui est exactement la
 * situation qui produit une mauvaise décision.
 */
export async function leverConflit(
  db: Kysely<Database>,
  opts: LeverConflitOptions,
): Promise<{ id: string }> {
  const item = await createInboxItem(db, {
    type: 'approval',
    subtype: CONFLIT_INBOX_SUBTYPE,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
    fromRole: 'garant',
    title: `Deux savoirs se contredisent · « ${opts.existant.sujet} »`,
    payload: {
      cause: 'savoir.conflit',
      ctx: [
        `Un savoir actif porte déjà le sujet « ${opts.existant.sujet} » dans ce cercle, et le garant en propose un autre.`,
        '',
        "Détection par sujet : deux savoirs rangés sous des sujets différents ne seront PAS confrontés ici. Ce n'est donc pas une garantie d'absence de contradiction ailleurs — la revue de péremption reste le filet.",
      ].join('\n'),
      sujet: opts.existant.sujet,
      cercle: opts.existant.cercle,
      cercle_id: opts.existant.cercleId,
      existant: {
        racine_id: opts.existant.racineId,
        version: opts.existant.version,
        contenu: opts.existant.contenu,
        rappels: opts.existant.rappels,
      },
      propose: { sujet: opts.propose.sujet, contenu: opts.propose.contenu },
    },
  })
  return { id: item.id }
}

export type IssueConflit =
  | { action: 'remplacer' }
  | { action: 'garder' }
  | { action: 'fusionner'; contenu: string }

/**
 * Applique la décision humaine.
 *
 * `remplacer` et `fusionner` passent tous deux par `corriger()` : ils
 * produisent une NOUVELLE VERSION du savoir existant, jamais une seconde
 * entrée concurrente. C'est le point — sans ça, résoudre un conflit en
 * créerait un second, et l'historique perdrait le lien entre les deux
 * formulations.
 *
 * `garder` n'écrit rien : la proposition est simplement abandonnée. Le refus
 * est déjà tracé par l'item résolu, qui fait foi.
 */
export async function resoudreConflit(
  db: Kysely<Database>,
  racineId: string,
  issue: IssueConflit,
  proposeContenu: string,
): Promise<Savoir | null> {
  if (issue.action === 'garder') return null
  const contenu = issue.action === 'fusionner' ? issue.contenu : proposeContenu
  return corriger(db, racineId, contenu)
}

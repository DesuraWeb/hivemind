import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { createInboxItem, listInbox } from '../inbox/repo'
import { PERIODE_REVUE_JOURS, fileDeRevue } from './review'

/**
 * Prévenir qu'il y a une revue à faire.
 *
 * `review.ts` disait honnêtement, en tête de fichier : « il ne planifie rien
 * et ne prévient personne. Le pack parle d'une revue trimestrielle annoncée
 * dans le brief du matin : aucun job ne la déclenche aujourd'hui. » L'écran
 * existait, la file se calculait, et personne ne savait jamais qu'il fallait
 * y aller. Une mémoire qu'on ne relit jamais vieillit sans qu'on s'en rende
 * compte — c'est exactement ce que la revue devait empêcher.
 *
 * ## La difficulté n'est pas de prévenir, c'est de ne pas harceler
 *
 * Un rappel qui revient tous les jours devient un rappel qu'on ferme sans
 * lire, et à ce moment-là il vaut moins que rien : il apprend à ignorer
 * l'inbox. Trois règles, toutes vérifiables :
 *
 * - **un seul à la fois** : tant que le rappel précédent est ouvert, aucun
 *   autre n'est levé ;
 * - **après résolution, il faut une raison** : soit la file a GRANDI depuis
 *   le dernier rappel, soit il date de plus d'un mois. Résoudre le rappel
 *   sans faire la revue ne le fait donc pas disparaître pour toujours, et
 *   faire la revue en partie ne le fait pas revenir le lendemain ;
 * - **rien à revoir, rien à dire** : file vide, aucun rappel.
 *
 * La décision est une fonction pure (`deciderRappelRevue`) : le plancher d'un
 * mois et la croissance de la file se testent sans base et sans horloge.
 */

export const REVUE_INBOX_SUBTYPE = 'revue'

/** Plancher : au bout d'un mois, le rappel revient même si la file n'a pas grandi. */
export const PLANCHER_RAPPEL_JOURS = 30

const JOUR_MS = 86_400_000

export interface EtatRappelRevue {
  /** Combien de savoirs attendent une confirmation humaine, maintenant. */
  aRevoir: number
  /** Un rappel est-il déjà ouvert en inbox ? */
  rappelOuvert: boolean
  /** Le dernier rappel levé, ouvert ou non. `null` si on n'a jamais prévenu. */
  dernier: { aRevoir: number; leveA: Date } | null
}

export type DecisionRappelRevue = { lever: false; raison: string } | { lever: true; raison: string }

export function deciderRappelRevue(etat: EtatRappelRevue, now: Date): DecisionRappelRevue {
  if (etat.aRevoir === 0) {
    return { lever: false, raison: 'rien à revoir' }
  }
  if (etat.rappelOuvert) {
    return { lever: false, raison: 'un rappel est déjà ouvert' }
  }
  if (!etat.dernier) {
    return { lever: true, raison: 'premier rappel' }
  }

  if (etat.aRevoir > etat.dernier.aRevoir) {
    return {
      lever: true,
      raison: `la file a grandi · ${etat.dernier.aRevoir} → ${etat.aRevoir}`,
    }
  }

  const jours = Math.floor((now.getTime() - etat.dernier.leveA.getTime()) / JOUR_MS)
  if (jours >= PLANCHER_RAPPEL_JOURS) {
    return { lever: true, raison: `dernier rappel il y a ${jours} j` }
  }

  // Le cas qui fait tout l'intérêt de cette fonction : la file n'a pas grandi
  // et le rappel est récent. Se taire est la bonne réponse, même s'il reste
  // des savoirs à revoir.
  return { lever: false, raison: `rappel récent (${jours} j) et file stable` }
}

export interface ResultatRappelRevue {
  leve: boolean
  raison: string
  aRevoir: number
  itemId?: string
}

/**
 * Calcule la file, décide, et lève le rappel s'il y a lieu.
 *
 * Aucun échange modèle : `phraseHive` (review.ts) est calculée, pas rédigée —
 * même refus du coût récurrent que partout ailleurs dans cette phase. Le
 * rappel dit des nombres que la base porte, et rien d'autre.
 */
export async function rappelerRevue(
  db: Kysely<Database>,
  now = new Date(),
): Promise<ResultatRappelRevue> {
  const revue = await fileDeRevue(db, now)
  const historique = await listInbox(db, { type: 'info' })
  const rappels = historique
    .filter((i) => i.subtype === REVUE_INBOX_SUBTYPE)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

  const dernier = rappels[0]
  const decision = deciderRappelRevue(
    {
      aRevoir: revue.aRevoir,
      rappelOuvert: rappels.some((i) => i.status === 'open'),
      dernier: dernier
        ? {
            aRevoir: typeof dernier.payload.aRevoir === 'number' ? dernier.payload.aRevoir : 0,
            leveA: dernier.createdAt,
          }
        : null,
    },
    now,
  )

  if (!decision.lever) {
    return { leve: false, raison: decision.raison, aRevoir: revue.aRevoir }
  }

  const item = await createInboxItem(db, {
    type: 'info',
    subtype: REVUE_INBOX_SUBTYPE,
    // 'system' : personne n'a rédigé ce rappel, il est CALCULÉ. Lui coller un
    // nom d'agent laisserait croire qu'un rôle a jugé la mémoire — or aucun
    // n'a lu le contenu des savoirs, seulement compté leurs rappels.
    fromRole: 'system',
    title: `Revue des savoirs · ${revue.aRevoir} à revoir`,
    payload: {
      aRevoir: revue.aRevoir,
      actifs: revue.actifs,
      periodeJours: PERIODE_REVUE_JOURS,
      // La phrase de Hive telle que l'écran de revue l'affiche : le rappel dit
      // exactement ce qu'on lira en cliquant, jamais une version plus alarmante.
      hive: revue.hive,
      raison: decision.raison,
    },
  })

  return { leve: true, raison: decision.raison, aRevoir: revue.aRevoir, itemId: item.id }
}

import type { BudgetThresholds } from './scheduler'

/**
 * Le déblocage de la réserve (Phase 5, complément de la Task 2).
 *
 * ## Le trou que ça bouche
 *
 * Le scheduler protège les 15 derniers points de jauge : au-delà de 85 %, tous
 * les runs passent en `paused_budget`. Ces points sont décrits partout comme
 * « gardés pour les urgences » — mais rien ne permettait d'y toucher. Florian
 * voyait « pause » dans la liste des projets et n'avait aucun geste à faire.
 * Une réserve qu'on ne peut pas dépenser n'est pas une réserve, c'est un mur.
 *
 * ## Pourquoi une simple reprise manuelle ne suffisait pas
 *
 * Reprendre un run à la main pendant que la jauge est à 92 % le ferait
 * re-mettre en pause au tick suivant, cinq minutes plus tard. La reprise doit
 * donc s'accompagner d'un état : la réserve est *entamée*, et le seuil de
 * pause ne s'applique plus tant qu'elle l'est.
 *
 * C'est exactement le vocabulaire du pack DA, qui affiche déjà
 * `BUDGET.reserveState: "intacte"` — donc un état qui peut ne plus l'être.
 *
 * ## Pourquoi c'est borné dans le temps
 *
 * Un déblocage sans fin est un plafond supprimé, pas une réserve entamée. Il
 * expire tout seul : oublier de le refermer est le comportement normal d'un
 * humain occupé, pas une faute à sanctionner par une facture. Passée
 * l'échéance, le seuil revient sans que personne n'ait rien à faire.
 */

/** Clé de réglage portant l'échéance du déblocage (ISO 8601), ou rien si la réserve est intacte. */
export const RESERVE_UNLOCK_SETTINGS_KEY = 'budget.reserve_unlocked_until'

/**
 * Durée maximale d'un déblocage. Deux heures couvrent largement un correctif
 * urgent ; au-delà, ce n'est plus une urgence, c'est une limite mal réglée —
 * et c'est `budget.reserve_pct` qu'il faut changer, pas la réserve qu'il faut
 * tenir ouverte.
 */
export const MAX_UNLOCK_MINUTES = 120

/** Durée par défaut quand l'appelant n'en propose pas : de quoi finir un step. */
export const DEFAULT_UNLOCK_MINUTES = 30

export type ReserveState = 'intacte' | 'entamee'

export interface ReserveStatus {
  state: ReserveState
  /** Échéance du déblocage en cours. Absente quand la réserve est intacte. */
  until?: Date
}

/** Lit l'échéance sans lui faire confiance : le réglage peut contenir n'importe quel JSON. */
export function parseUnlockUntil(value: unknown, now: Date): ReserveStatus {
  if (typeof value !== 'string' || value.length === 0) return { state: 'intacte' }
  const until = new Date(value)
  if (Number.isNaN(until.getTime())) return { state: 'intacte' }
  // Une échéance passée n'est pas une erreur : c'est un déblocage qui a expiré
  // comme prévu, et personne n'a eu à le refermer.
  if (until.getTime() <= now.getTime()) return { state: 'intacte' }
  return { state: 'entamee', until }
}

/**
 * Le seuil de pause effectif. Réserve entamée ⇒ plus de seuil : on va jusqu'au
 * bout de ce que le compte permet, ce qui est précisément le sens de « puiser
 * dans la réserve ».
 *
 * Volontairement une fonction à part plutôt qu'une modification de
 * `pauseThreshold` : celui-ci exprime la règle permanente, celle-ci exprime
 * une dérogation datée. Les confondre rendrait impossible d'afficher
 * honnêtement « seuil 85 %, dérogation en cours jusqu'à 16 h 20 ».
 */
export function effectivePauseThreshold(
  thresholds: BudgetThresholds,
  reserve: ReserveStatus,
): number {
  if (reserve.state === 'entamee') return 100
  return 100 - thresholds.reservePct
}

/** Borne la durée demandée. Une valeur absurde devient la valeur par défaut, jamais une erreur 500. */
export function clampUnlockMinutes(minutes: unknown): number {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return DEFAULT_UNLOCK_MINUTES
  if (minutes < 1) return DEFAULT_UNLOCK_MINUTES
  return Math.min(Math.floor(minutes), MAX_UNLOCK_MINUTES)
}

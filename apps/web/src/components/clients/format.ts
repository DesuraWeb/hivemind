import { ageMinutes, formatAge } from '../../lib/age'
import type { ClientKnowledgeView } from '../../lib/api'

/**
 * Mises en forme partagées par la liste et la fiche client. Rien ici
 * n'invente de donnée : ce qui n'est pas connu se dit, jamais ne se remplit.
 */

/** « 3 clients », « 1 client », « 0 client » : le zéro reste au singulier (accord français). */
export function count(n: number, singular: string, plural: string): string {
  return `${n} ${n > 1 ? plural : singular}`
}

/**
 * Initiales de la pastille. Le point médian sépare les noms de fiche comme il
 * sépare tout le reste (« Démo · PrestaShop ») : il n'est pas une initiale.
 */
export function initials(name: string): string {
  const words = name.split(/[\s·]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w))
  const letters = words.slice(0, 2).map((w) => [...w][0] ?? '')
  const out = letters.join('').toUpperCase()
  return out.length > 0 ? out : '?'
}

/**
 * « il y a 26 min » dans la journée, « 3 août » au-delà — les deux formes du
 * pack, choisies comme il les choisit : l'âge tant qu'il veut encore dire
 * quelque chose, la date ensuite.
 */
function whenLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'date illisible'
  if (ageMinutes(iso, now) < 24 * 60) return formatAge(iso, now)
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/**
 * La ligne de méta d'un savoir : quand il a été archivé, et d'où il vient.
 *
 * Le pack y affiche en plus une version (`v2`) et un score de rappel (« × 12
 * rappels »). Ni l'un ni l'autre n'est stocké : `clients.notes` ne contient que
 * `{q, a, source_item_id, at}`. Ils sont donc absents, et l'absence est dite
 * une fois pour toute la section — pas simulée par un « v1 » ou un zéro.
 */
export function knowledgeMeta(entry: ClientKnowledgeView): string {
  const parts: string[] = []
  if (entry.at) parts.push(whenLabel(entry.at))
  // L'identifiant d'item est un UUID : on n'en montre que la tête, le titre
  // HTML porte la valeur complète pour qui doit la recopier.
  if (entry.sourceItemId) parts.push(`via inbox ${entry.sourceItemId.slice(0, 8)}`)
  return parts.length > 0 ? parts.join(' · ') : 'origine inconnue'
}

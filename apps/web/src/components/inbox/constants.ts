import type { InboxType } from '@silithid/shared'

/** Repris de Inbox.dc.html (Component.TAG / SEM / WEIGHT). */
export const TAG: Record<InboxType, string> = {
  question: 'QUESTION',
  approval: 'VALIDATION',
  verdict: 'VERDICT',
  alert: 'ALERTE',
  handoff: 'PASSATION',
  info: 'INFO',
}

/** Variable CSS (pas la couleur résolue) : le token porte déjà le bon oklch par variante d'accent. */
export const SEM: Record<InboxType, string> = {
  question: 'var(--sem-question)',
  approval: 'var(--sem-approval)',
  verdict: 'var(--sem-verdict)',
  alert: 'var(--sem-alert)',
  handoff: 'var(--sem-approval)',
  info: 'var(--text-low)',
}

/** Ordre de tri par défaut de la liste : alerte d'abord, puis question, validation, verdict. */
export const WEIGHT: Record<InboxType, number> = {
  alert: 0,
  question: 1,
  approval: 2,
  verdict: 3,
  handoff: 4,
  info: 5,
}

export const TYPE_CHIP_DEFS: Array<{ id: 'all' | InboxType; label: string }> = [
  { id: 'all', label: 'Tout' },
  { id: 'question', label: 'Questions' },
  { id: 'approval', label: 'Validations' },
  { id: 'verdict', label: 'Verdicts' },
  { id: 'alert', label: 'Alertes' },
]

/** Label composé « TYPE · SOUS-TYPE » (ex. « VALIDATION · EMAIL »), comme `T[it.type] + " · " + it.sub.toUpperCase()`. */
export function tagLabel(type: InboxType, sub?: string): string {
  return sub ? `${TAG[type]} · ${sub.toUpperCase()}` : TAG[type]
}

/** UUID interne raccourci pour tenir dans la place prévue par le prototype pour des ids courts (« q-112 »). */
export function shortId(id: string): string {
  return id.slice(0, 8)
}

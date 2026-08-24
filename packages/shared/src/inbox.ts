export const INBOX_TYPES = ['question', 'approval', 'handoff', 'verdict', 'alert', 'info'] as const
export type InboxType = (typeof INBOX_TYPES)[number]

export const APPROVAL_SUBTYPES = [
  'email',
  'prod',
  'savoir',
  'step_end',
  /** Un changement sur un serveur en service (Phase 6). */
  'ops',
  /**
   * Une étape qui rejoindrait la recette d'une stack (Phase 6). Distincte de
   * `ops` par sa PORTÉE : `ops` vaut pour un serveur, `recette` pour tous les
   * prochains de cette stack. C'est le seul sous-type qui élargit ce qui
   * s'exécute sans validation.
   */
  'recette',
] as const
export type ApprovalSubtype = (typeof APPROVAL_SUBTYPES)[number]

export const INBOX_STATUSES = ['open', 'done', 'dismissed'] as const
export type InboxStatus = (typeof INBOX_STATUSES)[number]

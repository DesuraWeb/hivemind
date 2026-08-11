export const INBOX_TYPES = ['question', 'approval', 'handoff', 'verdict', 'alert', 'info'] as const
export type InboxType = (typeof INBOX_TYPES)[number]

export const APPROVAL_SUBTYPES = ['email', 'prod', 'step_end'] as const
export type ApprovalSubtype = (typeof APPROVAL_SUBTYPES)[number]

export const INBOX_STATUSES = ['open', 'done', 'dismissed'] as const
export type InboxStatus = (typeof INBOX_STATUSES)[number]

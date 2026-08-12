/** Nature d'un message du bus inter-agents (brief §5, colonne `messages.kind`). */
export const MESSAGE_KINDS = ['prompt', 'report', 'question', 'correction', 'info'] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

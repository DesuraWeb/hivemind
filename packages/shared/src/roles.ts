export const ROLE_KEYS = ['majordome', 'garant', 'dev', 'reviewer', 'judge', 'communicant'] as const
export type RoleKey = (typeof ROLE_KEYS)[number]

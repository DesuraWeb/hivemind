export const ROLE_KEYS = [
  'majordome',
  'garant',
  'dev',
  'reviewer',
  'judge',
  'communicant',
  /**
   * L'exploitation (Phase 6) : le seul rôle qui parle à des serveurs. Ajouté
   * en dernier volontairement — c'est aussi le plus dangereux, et il n'a
   * aucun outil d'exécution, seulement de la lecture et une sortie
   * structurée que du code serveur traduit en commandes bornées.
   */
  'ops',
] as const
export type RoleKey = (typeof ROLE_KEYS)[number]

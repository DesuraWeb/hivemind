/**
 * L'état d'un serveur, qui décide de l'autonomie de l'agent d'exploitation.
 *
 * Arbitrage de Florian (14/08) : ce n'est pas à qui appartient le serveur qui
 * détermine ce que l'agent peut faire, c'est ce qu'il y a déjà dessus.
 *
 * - `inconnu` — jamais mesuré. Aucune autonomie : on sonde d'abord.
 * - `vierge` — rien ne répond, aucune donnée, aucun trafic. Champ libre.
 * - `en_service` — quelque chose vit là. Proposer, faire valider, appliquer.
 */
export const ETATS_SERVEUR = ['inconnu', 'vierge', 'en_service'] as const
export type EtatServeur = (typeof ETATS_SERVEUR)[number]

/**
 * À qui un savoir de stack s'adresse.
 *
 * `code` : le dev et le garant, dans le cadrage d'un step. `exploitation` :
 * l'agent ops, dans un plan de déploiement. Les deux mémoires apprennent par
 * stack et n'ont rien à se dire — mêler « eager loading par défaut » à un plan
 * de serveur dilue les deux (migration 0012).
 */
export const DOMAINES_SAVOIR = ['code', 'exploitation'] as const
export type DomaineSavoir = (typeof DOMAINES_SAVOIR)[number]

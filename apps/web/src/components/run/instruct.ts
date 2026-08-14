/**
 * Miroir front d'`INSTRUCTABLE_ROLES` (apps/server/src/loop/instructions.ts) :
 * les seuls rôles dont le handler relit réellement le bus au démarrage de son
 * invocation (`framing.ts` pour le garant, `coding.ts` pour le dev).
 *
 * Le serveur refuse les autres en 400 — proposer « reviewer » ou « juge » dans
 * l'interface ferait cliquer sur une erreur, et pire : laisserait croire qu'on
 * peut leur parler. Une consigne qu'aucun handler ne lit est un silence, pas
 * un message.
 */
export const INSTRUCTABLE_ROLES = ['garant', 'dev'] as const
export type InstructableRole = (typeof INSTRUCTABLE_ROLES)[number]

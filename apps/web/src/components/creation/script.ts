/**
 * Les constantes de mise en scène du pack de Création.
 *
 * Ce fichier portait le SCRIPT : cinq répliques et leurs délais, rejoués à
 * chaque visite. Il n'en reste que ce qui est de la composition — teintes
 * d'orbe, rôles en orbite, cascade de mémoire. La conversation est réelle
 * maintenant, et son rythme vient de l'agent, pas d'un tableau d'horaires.
 */

export type CreationMode = 'projet' | 'globe'

export interface ScriptStep {
  /** Millisecondes après le début du script. */
  at: number
  stage: number
  text: string
}

export const GLOBE_TINTS = ['#B49FE0', '#7FB8E8', '#8FCDA8'] as const

/**
 * L'équipe en orbite autour de l'orbe. Le pack fixe le nom affiché, la couleur
 * et l'angle de chaque rôle ; la VERSION, elle, n'est pas écrite ici : elle
 * vient de `/api/role-templates`. `majordome` est absent de la liste — c'est
 * Hive, il est déjà au centre.
 */
export const TEAM_ROLES: { key: string; label: string; color: string; angle: number }[] = [
  { key: 'garant', label: 'Garant', color: 'oklch(0.82 0.06 235)', angle: -168 },
  { key: 'dev', label: 'Dev', color: 'var(--accent)', angle: -120 },
  { key: 'reviewer', label: 'Reviewer', color: 'var(--sem-question)', angle: -68 },
  { key: 'judge', label: 'Juge', color: 'var(--sem-verdict)', angle: -18 },
  { key: 'communicant', label: 'Communicant', color: 'var(--ok)', angle: 30 },
]

/**
 * Ce que la cascade mémoire fait d'un globe (`CLAUDE.md` : projet → client →
 * globe → Hive). Remplace les quatre cases à cocher « Mémoire héritée » du
 * prototype : aucune route ne règle un héritage à la création, des cases
 * cochées y feraient croire à un arbitrage qui n'existe pas. La seule ligne du
 * pack qui disait vrai — les secrets ne traversent pas un globe — est celle
 * qui survit intacte.
 */
export const MEMORY_CASCADE: { num: string; name: string; meta: string; dim: boolean }[] = [
  {
    num: '01',
    name: 'Projet',
    meta: 'le cercle le plus proche · ce qui ne vaut que pour lui',
    dim: false,
  },
  { num: '02', name: 'Client', meta: "sa fiche, son ton, ce qu'il a déjà répondu", dim: false },
  {
    num: '03',
    name: 'Globe',
    meta: 'ce que vous créez · sa mémoire commence presque vide',
    dim: false,
  },
  {
    num: '04',
    name: 'Hive',
    meta: 'racine · vos arbitrages, jamais les secrets clients',
    dim: true,
  },
]

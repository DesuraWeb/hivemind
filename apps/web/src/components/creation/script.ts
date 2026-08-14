/**
 * La mise en scène de `docs/design/Creation.dc.html` : deux scripts (projet,
 * globe) qui font monter `stage` et changent la phrase au centre, chaque étape
 * faisant parler l'oscilloscope 2,3 s avant de le remettre au repos.
 *
 * ## Les délais viennent du pack, les textes non
 *
 * `at` et `stage` sont repris tels quels (300/4200/8200/11400/15000 pour le
 * projet, 300/4000/7800 pour le globe) : c'est le rythme de la scène, et il
 * fait foi au pixel comme à la milliseconde.
 *
 * Les répliques, elles, sont réécrites. Le prototype fait dire à Hive qu'il a
 * challengé une stack, réglé des boucles « au plus juste » et créé un dépôt,
 * et fait dire à Florian des phrases qu'il n'a jamais prononcées. Aucun agent
 * n'écoute cet écran aujourd'hui : rejouer ces répliques telles quelles
 * afficherait une conversation qui n'a pas eu lieu et des gestes qui n'ont pas
 * été faits. Les textes ci-dessous ne disent que ce qui est vrai — ce que le
 * fragment qui vient d'apparaître attend de vous, et ce que la création fera
 * réellement.
 */

export type CreationMode = 'projet' | 'globe'

export interface ScriptStep {
  /** Millisecondes après le début du script. */
  at: number
  stage: number
  text: string
}

export const INTRO_TEXT = "On crée quoi aujourd'hui · un projet, ou un nouveau globe ?"

export const SCRIPT_PROJET: ScriptStep[] = [
  {
    at: 300,
    stage: 1,
    text: "Commençons par l'identité : un nom, le globe qui l'accueille, et si vous voulez la fiche client et la stack. Rien n'est prérempli · je n'invente pas votre projet à votre place.",
  },
  {
    at: 4200,
    stage: 2,
    text: "Découpez le travail en steps. Chacun porte ses specs, son nombre d'itérations et son mode de boucle · full-auto ne concerne que l'aller-retour dev ↔ reviewer, la mise en prod reste un gate quoi qu'il arrive.",
  },
  {
    at: 8200,
    stage: 3,
    text: 'Voici les templates de rôles installés. Ils ne sont pas attachés au projet à la création : chaque rôle se matérialise au premier run qui en a besoin, dans sa version la plus récente.',
  },
  {
    at: 11400,
    stage: 4,
    text: "L'infra, maintenant · et sans détour : je ne crée ni dépôt, ni staging, et le coffre n'est pas branché à cet écran. Donnez-moi un dépôt qui existe déjà, je l'enregistre.",
  },
  {
    at: 15000,
    stage: 5,
    text: "La fiche est complète et rien ne démarre sans vous. J'enregistre le projet et ses steps ?",
  },
]

export const SCRIPT_GLOBE: ScriptStep[] = [
  {
    at: 300,
    stage: 1,
    text: "Un globe est un espace de conscience isolé : ses projets, ses clients, sa mémoire propre. Un nom et une teinte · c'est tout ce que je sais enregistrer aujourd'hui.",
  },
  {
    at: 4000,
    stage: 2,
    text: "Sa place dans la cascade mémoire est déjà écrite · il n'y a rien à arbitrer ici, et les secrets clients ne traversent jamais un globe.",
  },
  {
    at: 7800,
    stage: 3,
    text: 'Le globe est prêt · il apparaîtra sur sa propre orbite, sa conscience grossira toute seule. Je le crée ?',
  },
]

/** Dernier `stage` de chaque script : celui qui découvre le CTA. */
export const FINAL_STAGE: Record<CreationMode, number> = { projet: 5, globe: 3 }

export function scriptOf(mode: CreationMode): ScriptStep[] {
  return mode === 'projet' ? SCRIPT_PROJET : SCRIPT_GLOBE
}

/** Teintes proposées pour un nouveau globe (`GTINTS` du prototype). */
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

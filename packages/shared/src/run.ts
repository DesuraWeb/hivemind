export const RUN_STATES = [
  'framing',
  'coding',
  'design_wait',
  'reviewing',
  'deploying',
  'judging',
  'verdict',
  'awaiting_human',
  'done',
  'failed',
  'paused_budget',
  /**
   * Pause décidée par un humain. Distinct de `paused_budget` : le scheduler de
   * budget lève `paused_budget` dès que la jauge repasse sous le seuil de
   * reprise, ce qui annulerait une pause manuelle au tick suivant.
   */
  'paused_human',
  /**
   * Arrêt décidé par un humain. Terminal, mais distinct de `failed` : un arrêt
   * n'est pas un échec, et les confondre fausserait la lecture de la liste des
   * projets.
   */
  'stopped',
] as const
export type RunState = (typeof RUN_STATES)[number]

export const AUTONOMY_MODES = ['gated', 'auto'] as const
export type AutonomyMode = (typeof AUTONOMY_MODES)[number]

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
] as const
export type RunState = (typeof RUN_STATES)[number]

export const AUTONOMY_MODES = ['gated', 'auto'] as const
export type AutonomyMode = (typeof AUTONOMY_MODES)[number]

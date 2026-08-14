import type { AutonomyMode, InboxType, RoleKey, RunState } from '@silithid/shared'

export type LoopEvent =
  | { type: 'frame_ready' }
  | { type: 'pr_opened'; prNumber: number }
  | { type: 'review_ok' }
  | { type: 'review_ko' }
  | { type: 'ci_green' }
  | { type: 'ci_red'; reason: string }
  | { type: 'judge_report' }
  | { type: 'verdict_conforme' }
  | { type: 'verdict_ecarts' }
  | { type: 'question'; blocking: boolean; fromRole: RoleKey }
  | { type: 'human_resolved' }
  | { type: 'budget_pause' }
  | { type: 'budget_resume' }
  /**
   * Pause décidée par un humain. Volontairement distincte de `budget_pause` :
   * le scheduler de budget reprend tous les runs en `paused_budget` dès que la
   * jauge repasse sous le seuil de reprise (cas nominal, tick de 5 min), donc
   * ranger une pause manuelle dans cet état la ferait lever toute seule.
   */
  | { type: 'manual_pause' }
  | { type: 'manual_resume' }
  | { type: 'aborted'; reason: string }

export interface RunContext {
  iteration: number
  maxIterations: number
  reviewRound: number
  /** Borne dure des allers-retours dev↔reviewer. Brief §7 : 3. */
  maxReviewRounds: number
  autonomy: AutonomyMode
  /** État à restaurer en sortie de `awaiting_human` / `paused_budget`. */
  resumeState?: RunState
}

export type Effect =
  | {
      type: 'open_inbox_item'
      itemType: InboxType
      subtype?: string
      reason: string
      /**
       * Rôle à l'origine de l'item. Sans lui, l'UI ne peut pas distinguer une
       * question du garant d'une question du dev — c'est précisément pourquoi
       * `inbox_items.from_role` existe. Les items levés par la boucle
       * elle-même (échec, max_iterations) portent 'system'.
       */
      fromRole: RoleKey | 'system'
    }
  | { type: 'increment_iteration' }
  | { type: 'increment_review_round' }
  | { type: 'reset_review_round' }
  | { type: 'remember_resume_state'; state: RunState }
  | { type: 'clear_resume_state' }
  | { type: 'end_run'; outcome: 'done' | 'failed' | 'stopped' }

export type Decision =
  | { kind: 'transition'; to: RunState; effects: Effect[] }
  | { kind: 'stay'; effects: Effect[] }
  | { kind: 'invalid'; reason: string }

function invalid(reason: string): Decision {
  return { kind: 'invalid', reason }
}

function transition(to: RunState, effects: Effect[]): Decision {
  return { kind: 'transition', to, effects }
}

// États dans lesquels la boucle avance encore (ni en pause, ni en attente
// humaine, ni terminaux). Les événements génériques (question, budget_pause,
// manual_pause) ne s'appliquent que depuis l'un de ces états. `aborted` fait
// exception : il est traité avant, depuis TOUT état non terminal.
const ACTIVE_STATES: readonly RunState[] = [
  'framing',
  'coding',
  'design_wait',
  'reviewing',
  'deploying',
  'judging',
  'verdict',
]

export function decide(state: RunState, event: LoopEvent, ctx: RunContext): Decision {
  // Règle 2 : aucun événement ne fait sortir d'un état terminal.
  if (state === 'done' || state === 'failed' || state === 'stopped') {
    return invalid(`état terminal ${state} : aucun événement accepté`)
  }

  // Traité avant les blocs d'état : un arrêt humain doit pouvoir aboutir depuis
  // TOUT état non terminal, pas seulement depuis un état actif. Un run en
  // attente d'une réponse que Florian ne veut pas donner, ou qu'il vient de
  // mettre en pause pour regarder ce qu'il fait, doit pouvoir être arrêté —
  // sinon le seul recours resterait d'attendre `max_iterations`, c'est-à-dire
  // exactement le manque que cette route vient combler.
  //
  // `stopped` et non `failed` : l'humain a décidé, ce n'est pas un échec.
  // Aucun item d'inbox non plus, pour la même raison — il n'a pas à être
  // notifié de sa propre décision.
  if (event.type === 'aborted') {
    return transition('stopped', [{ type: 'end_run', outcome: 'stopped' }])
  }

  if (state === 'awaiting_human') {
    if (event.type === 'human_resolved') {
      if (!ctx.resumeState) return invalid('human_resolved sans resume_state à restaurer')
      return transition(ctx.resumeState, [{ type: 'clear_resume_state' }])
    }
    return invalid(`événement ${event.type} invalide depuis awaiting_human`)
  }

  if (state === 'paused_budget') {
    if (event.type === 'budget_resume') {
      if (!ctx.resumeState) return invalid('budget_resume sans resume_state à restaurer')
      // Décision B : une seule colonne resume_state, lue ET effacée à la
      // reprise — que la reprise vienne d'un humain ou du scheduler de budget.
      return transition(ctx.resumeState, [{ type: 'clear_resume_state' }])
    }
    return invalid(`événement ${event.type} invalide depuis paused_budget`)
  }

  if (state === 'paused_human') {
    // Seul `manual_resume` sort d'ici : `budget_resume` y est refusé, et c'est
    // la garantie recherchée — le scheduler de budget ne peut pas lever une
    // pause décidée par un humain, même s'il l'essayait.
    if (event.type === 'manual_resume') {
      if (!ctx.resumeState) return invalid('manual_resume sans resume_state à restaurer')
      return transition(ctx.resumeState, [{ type: 'clear_resume_state' }])
    }
    return invalid(`événement ${event.type} invalide depuis paused_human`)
  }

  // À partir d'ici, `state` est l'un des ACTIVE_STATES.

  if (event.type === 'question') {
    // Brief §7 : TOUTE question d'un agent crée un item d'inbox ; seule une
    // question bloquante met en plus le run en attente. Sans l'item, un run
    // bloqué serait invisible — personne ne saurait qu'il attend une réponse.
    if (event.blocking) {
      return transition('awaiting_human', [
        { type: 'remember_resume_state', state },
        {
          type: 'open_inbox_item',
          itemType: 'question',
          reason: 'question bloquante posée par un agent',
          fromRole: event.fromRole,
        },
      ])
    }
    return {
      kind: 'stay',
      effects: [
        {
          type: 'open_inbox_item',
          itemType: 'question',
          reason: 'question non bloquante posée par un agent',
          fromRole: event.fromRole,
        },
      ],
    }
  }

  if (event.type === 'budget_pause') {
    return transition('paused_budget', [{ type: 'remember_resume_state', state }])
  }

  if (event.type === 'manual_pause') {
    // Même mémorisation que la pause budgétaire, dans la même colonne : on
    // n'est jamais en pause manuelle ET en pause budgétaire à la fois, puisque
    // les deux ne partent que d'un état actif.
    return transition('paused_human', [{ type: 'remember_resume_state', state }])
  }

  switch (state) {
    case 'framing':
      if (event.type === 'frame_ready') return transition('coding', [])
      break

    case 'coding':
      if (event.type === 'pr_opened') return transition('reviewing', [])
      break

    case 'reviewing':
      if (event.type === 'review_ok') {
        return transition('deploying', [{ type: 'reset_review_round' }])
      }
      if (event.type === 'review_ko') {
        // Le round qui suivrait un nouvel aller-retour est-il encore sous la
        // borne dure (brief §7 : 3) ? Sinon, on n'incrémente plus : on bascule
        // vers un humain (décision A) sans épuiser silencieusement la borne.
        if (ctx.reviewRound + 1 < ctx.maxReviewRounds) {
          return transition('coding', [{ type: 'increment_review_round' }])
        }
        return transition('awaiting_human', [
          {
            type: 'open_inbox_item',
            itemType: 'alert',
            reason: 'boucle dev↔reviewer épuisée (3 allers-retours)',
            fromRole: 'reviewer',
          },
          { type: 'remember_resume_state', state: 'reviewing' },
        ])
      }
      break

    case 'deploying':
      if (event.type === 'ci_green') return transition('judging', [])
      if (event.type === 'ci_red') {
        return transition('awaiting_human', [
          { type: 'open_inbox_item', itemType: 'alert', reason: event.reason, fromRole: 'system' },
        ])
      }
      break

    case 'judging':
      if (event.type === 'judge_report') return transition('verdict', [])
      break

    case 'verdict':
      if (event.type === 'verdict_conforme') {
        if (ctx.autonomy === 'gated') {
          // Gate structurel de la DoD §14 : un verdict conforme ne saute
          // jamais l'approbation humaine hors du mode auto.
          return transition('awaiting_human', [
            {
              type: 'open_inbox_item',
              itemType: 'approval',
              subtype: 'step_end',
              reason: 'verdict conforme : validation humaine requise (mode gated)',
              fromRole: 'garant',
            },
          ])
        }
        return transition('done', [{ type: 'end_run', outcome: 'done' }])
      }
      if (event.type === 'verdict_ecarts') {
        if (ctx.iteration < ctx.maxIterations) {
          return transition('framing', [
            { type: 'increment_iteration' },
            { type: 'reset_review_round' },
          ])
        }
        return transition('failed', [
          {
            type: 'open_inbox_item',
            itemType: 'alert',
            reason: 'itérations épuisées, écarts persistants',
            fromRole: 'garant',
          },
          { type: 'end_run', outcome: 'failed' },
        ])
      }
      break

    case 'design_wait':
      // Aucune règle spécifique : seuls les événements génériques ci-dessus
      // s'appliquent. Aucune transition ne mène ici à ce jour.
      break

    default:
      break
  }

  return invalid(`événement ${event.type} invalide depuis ${state}`)
}

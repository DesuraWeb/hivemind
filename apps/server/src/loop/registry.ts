/**
 * Câblage du `StepRegistry` de production (Task 5, Phase 4, critère de fin).
 *
 * `stepOnce` (`../jobs/run-step.ts`) lève explicitement si aucun handler
 * n'est enregistré pour l'état courant du run : un état sans entrée ici
 * laisserait un run coincé, sans le moindre message d'erreur avant l'échec du
 * job pg-boss. `RUN_STATES` (`@silithid/shared`) compte onze états ; six sont
 * actifs et couverts ci-dessous (`framing`, `coding`, `reviewing`,
 * `deploying`, `judging`, `verdict`) ; `design_wait` est un état ACTIF
 * (`domain/run-state.ts`, `ACTIVE_STATES`) mais qu'AUCUNE transition de
 * `decide()` ne produit encore (juge visuel = J8, hors périmètre de la Phase
 * 3 qui l'a introduit) — il ne peut donc jamais être atteint tant que rien
 * n'y transitionne, câbler un handler dessus serait spéculatif ; les quatre
 * restants (`awaiting_human`, `done`, `failed`, `paused_budget`) sont dans
 * `NO_REQUEUE_STATES` et n'ont structurellement pas besoin de handler
 * (`stepOnce` retourne avant même de consulter le registre).
 */

import type { StepRegistry } from '../jobs/run-step'
import type { RuntimeAdapter } from '../runtime/types'
import { createCodingHandler } from './steps/coding'
import { createDeployingHandler } from './steps/deploying'
import { createFramingHandler } from './steps/framing'
import { createJudgingHandler } from './steps/judging'
import { createReviewingHandler } from './steps/reviewing'
import { createVerdictHandler } from './steps/verdict'

export interface StepRegistryDeps {
  adapter: RuntimeAdapter
  /** `WORKTREES_ROOT` — racine des clones/worktrees (décision C, plan Phase 2). */
  worktreesRoot: string
  /** `ARTIFACTS_ROOT` — racine de stockage des captures (Task 1, Phase 4). */
  artifactsRoot: string
}

/** Construit le `StepRegistry` réel — les six handlers d'état, un `RuntimeAdapter` partagé. */
export function createStepRegistry(deps: StepRegistryDeps): StepRegistry {
  return {
    framing: createFramingHandler({ adapter: deps.adapter, worktreesRoot: deps.worktreesRoot }),
    coding: createCodingHandler({ adapter: deps.adapter, worktreesRoot: deps.worktreesRoot }),
    reviewing: createReviewingHandler({
      adapter: deps.adapter,
      worktreesRoot: deps.worktreesRoot,
    }),
    deploying: createDeployingHandler({ artifactsRoot: deps.artifactsRoot }),
    judging: createJudgingHandler({ adapter: deps.adapter, artifactsRoot: deps.artifactsRoot }),
    verdict: createVerdictHandler({ adapter: deps.adapter }),
  }
}

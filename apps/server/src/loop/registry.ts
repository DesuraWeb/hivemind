/**
 * Câblage du `StepRegistry` de production (Task 5, Phase 4, critère de fin).
 *
 * `stepOnce` (`../jobs/run-step.ts`) lève explicitement si aucun handler
 * n'est enregistré pour l'état courant du run : un état sans entrée ici
 * laisserait un run coincé, sans le moindre message d'erreur avant l'échec du
 * job pg-boss. `RUN_STATES` (`@silithid/shared`) compte treize états ; six sont
 * actifs et couverts ci-dessous (`framing`, `coding`, `reviewing`,
 * `deploying`, `judging`, `verdict`) ; `design_wait` est un état ACTIF
 * (`domain/run-state.ts`, `ACTIVE_STATES`) mais qu'AUCUNE transition de
 * `decide()` ne produit encore (le juge visuel existe depuis la Phase 4 et ne
 * transitionne pas par cet état) — il ne peut donc jamais être atteint tant que rien
 * n'y transitionne, câbler un handler dessus serait spéculatif ; les six
 * restants (`awaiting_human`, `done`, `failed`, `paused_budget`,
 * `paused_human`, `stopped`) sont dans `NO_REQUEUE_STATES` et n'ont
 * structurellement pas besoin de handler (`stepOnce` retourne avant même de
 * consulter le registre).
 */

import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { resoudreAcces } from '../deploy/cibles'
import { createLocalPreviewTarget } from '../deploy/local-preview'
import { createSshGitTarget } from '../deploy/ssh-git'
import type { DeployTarget } from '../deploy/types'
import type { StepRegistry } from '../jobs/run-step'
import type { RuntimeAdapter } from '../runtime/types'
import type { SettingsStore } from '../settings/store'
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
  /**
   * Où déployer avant de capturer. Omis, c'est l'aperçu local — le bon défaut
   * pour un projet sans hébergement de recette, et le seul disponible tant que
   * le staging réel n'est pas configuré (Phase 5, Task 3).
   */
  deployTarget?: DeployTarget
  /**
   * De quoi résoudre la cible CONFIGURÉE d'un projet. Les deux ensemble ou
   * aucun : sans la base on ne sait pas où va le projet, sans le coffre on ne
   * peut pas s'y connecter. En fournir un seul donnerait un repli silencieux
   * sur l'aperçu local, exactement ce qu'on cherche à supprimer.
   */
  db?: Kysely<Database>
  settings?: SettingsStore
}

/**
 * Résout la cible de staging d'un projet, ou `null`.
 *
 * `null` n'est pas une panne : c'est un projet dont personne n'a encore dit où
 * il allait. Une clé manquante, en revanche, LÈVE — `resoudreAcces` refuse de
 * traiter une configuration à moitié faite comme une absence de configuration.
 */
function cibleDuProjet(
  db: Kysely<Database>,
  settings: SettingsStore,
): (projectId: string) => Promise<DeployTarget | null> {
  return async (projectId) => {
    const acces = await resoudreAcces(db, settings, projectId, 'staging')
    if (!acces) return null

    return createSshGitTarget({
      config: {
        host: acces.hote,
        user: acces.utilisateur,
        privateKey: acces.clePrivee,
        // `root` et `domain` ne sont PAS lus : `resolveDir` et `resolveUrl`
        // les court-circuitent tous les deux. Renseignés avec les valeurs de
        // la cible plutôt qu'avec des chaînes vides, pour qu'un message
        // d'erreur qui les citerait un jour reste vrai.
        root: acces.chemin,
        domain: acces.domaine ?? acces.hote,
      },
      // Le dépôt du projet et la branche du run. Sans ça, `createSshGitTarget`
      // refuse de déployer et rend « aucune source » — ce qui aurait fait de
      // tout ce câblage une décoration qui échoue au premier vrai passage.
      resolveSource: async (ctx) => {
        const row = await db
          .selectFrom('runs')
          .innerJoin('steps', 'steps.id', 'runs.step_id')
          .innerJoin('projects', 'projects.id', 'steps.project_id')
          .select(['runs.branch as branch', 'projects.repo_full_name as repoFullName'])
          .where('runs.id', '=', ctx.runId)
          .executeTakeFirst()
        if (!row?.branch) return null
        return { repoFullName: row.repoFullName, branch: row.branch }
      },
      resolveDir: () => acces.chemin,
      // Le domaine de la cible fait foi. Sans domaine déclaré, on rend l'hôte
      // — imparfait, mais honnête : c'est là que le code a réellement été
      // posé, et le juge saura le dire s'il ne s'y trouve rien.
      resolveUrl: () => (acces.domaine ? `https://${acces.domaine}` : `https://${acces.hote}`),
    })
  }
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
    // L'aperçu local n'est plus qu'un REPLI. La cible d'un projet configuré
    // gagne — `createSshGitTarget` existait depuis la Phase 5 et n'était
    // construit nulle part, ce qui expliquait que le gate de prod annonce
    // toujours « aperçu local éphémère ».
    deploying: createDeployingHandler({
      artifactsRoot: deps.artifactsRoot,
      target: deps.deployTarget ?? createLocalPreviewTarget(),
      ...(deps.db && deps.settings ? { resolveTarget: cibleDuProjet(deps.db, deps.settings) } : {}),
    }),
    judging: createJudgingHandler({ adapter: deps.adapter, artifactsRoot: deps.artifactsRoot }),
    verdict: createVerdictHandler({ adapter: deps.adapter }),
  }
}

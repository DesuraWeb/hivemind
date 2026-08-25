/**
 * L'état `deploying` : rendre le code du run visible à une URL, puis la
 * capturer pour le juge.
 *
 * DEPUIS LA PHASE 5 (Task 3), ce handler ne sait plus COMMENT on déploie. Il
 * reçoit une `DeployTarget` (`../../deploy/types.ts`) et s'en sert. L'aperçu
 * local qui était codé ici depuis la Phase 4 est devenu une implémentation
 * parmi d'autres (`../../deploy/local-preview.ts`) — c'est encore celle par
 * défaut, tant qu'aucun staging réel n'est configuré.
 *
 * DÉCISION SUR LA DURÉE DE VIE (Phase 4, toujours valable) — la capture a lieu
 * DANS ce passage, jamais plus tard : ce handler déploie, capture lui-même les
 * pages (`pages_to_judge` rendues par le garant en `framing`, lues depuis le
 * bus), enregistre les artifacts, puis relâche la cible avant de rendre la
 * main. `judging.ts` n'a donc besoin d'aucune ressource vivante : il relit les
 * captures sur disque via la table `artifacts`.
 *
 * Pourquoi pas l'option inverse (la ressource survit jusqu'à `judging`) :
 * `deploying` et `judging` sont deux passages DISTINCTS du worker,
 * potentiellement à des minutes d'écart, sur des jobs pg-boss retryables
 * indépendamment. Si le process crashait entre les deux, un serveur d'aperçu
 * survivant resterait orphelin indéfiniment. En capturant tout de suite, sa
 * durée de vie ne dépasse jamais un seul `stepOnce`.
 *
 * Noter que `release()` ne défait PAS le déploiement : sur un staging réel le
 * site reste en ligne, c'est tout l'intérêt. Voir la note de tête de
 * `../../deploy/types.ts`.
 */

import { join } from 'node:path'
import { recordCapturedPages } from '../../artifacts/store'
import type { DeployTarget } from '../../deploy/types'
import type { LoopEvent } from '../../domain/run-state'
import { capturePages } from '../../integrations/playwright'
import type { StepHandler } from '../../jobs/run-step'
import { type StoredMessage, appendMessage, readRunMessages } from '../bus'

export interface DeployingDeps {
  /** Racine de stockage des captures (`ARTIFACTS_ROOT`). */
  artifactsRoot: string
  /** Où déployer. `registry.ts` passe la cible du projet ; par défaut, l'aperçu local. */
  target: DeployTarget
}

/** Les `pages_to_judge` rendues par le garant en `framing` (même passation que `coding.ts`/`reviewing.ts` lisent pour `acceptance_criteria`). */
function findPagesToJudge(messages: StoredMessage[]): string[] {
  const frameMessage = [...messages]
    .reverse()
    .find((m) => m.kind === 'prompt' && m.fromRole === 'garant' && m.toRole === 'dev')
  const raw = frameMessage?.meta.pages_to_judge
  const pages = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
  // Si le garant n'a rendu aucune page explicite, on capture au moins la
  // racine plutôt que de ne rien capturer du tout : la cible vient de dire
  // qu'elle sert quelque chose, donc `/` est nécessairement atteignable.
  return pages.length > 0 ? pages : ['/']
}

export function createDeployingHandler(deps: DeployingDeps): StepHandler {
  return async (db, runId) => {
    const runRow = await db
      .selectFrom('runs')
      .innerJoin('steps', 'steps.id', 'runs.step_id')
      .innerJoin('projects', 'projects.id', 'steps.project_id')
      .select([
        'runs.worktree_path as worktreePath',
        'projects.slug as projectSlug',
        'projects.juge_visuel as jugeVisuel',
      ])
      .where('runs.id', '=', runId)
      .executeTakeFirstOrThrow()

    // Projet sans interface (API, bibliothèque, script) : rien à déployer,
    // rien à capturer, et surtout rien à juger. On traverse l'état sans
    // ouvrir de navigateur ni servir de fichiers.
    //
    // L'état n'est PAS sauté — `decide()` n'est pas touchée (c'est un fichier
    // sous garde, et modifier la machine à états pour une option de projet
    // serait disproportionné). Il devient simplement instantané, et la
    // timeline dit pourquoi plutôt que de laisser un `ci_green` inexpliqué.
    if (!runRow.jugeVisuel) {
      await appendMessage(db, {
        runId,
        fromRole: 'system',
        toRole: 'system',
        kind: 'info',
        body: 'Juge visuel désactivé sur ce projet · aucun déploiement, aucune capture.',
        meta: { juge_visuel: false },
      })
      return { type: 'ci_green' } satisfies LoopEvent
    }

    if (!runRow.worktreePath) {
      return {
        type: 'ci_red',
        reason: `run ${runId} : aucun worktree enregistré (runs.worktree_path est vide) — rien à servir`,
      } satisfies LoopEvent
    }

    const deployed = await deps.target.deploy({
      runId,
      worktreePath: runRow.worktreePath,
      projectSlug: runRow.projectSlug,
    })
    if (!deployed.ok) {
      return { type: 'ci_red', reason: deployed.reason } satisfies LoopEvent
    }

    try {
      const messages = await readRunMessages(db, runId)
      const pages = findPagesToJudge(messages)

      const artifactsDir = join(deps.artifactsRoot, runId)
      let captures: Awaited<ReturnType<typeof capturePages>>
      try {
        captures = await capturePages(deployed.url, pages, artifactsDir)
      } catch (err) {
        // Une capture ratée devient un `ci_red` lisible, pas une exception qui
        // remonte au job. La machine à états sait déjà quoi en faire :
        // `awaiting_human` avec une alerte d'inbox — donc Florian voit la
        // cause au lieu de trouver un run bloqué sans explication.
        //
        // Le cas qui a motivé ça : `pages_to_judge` en chemins de dépôt
        // (`public/index.html`) au lieu de chemins d'URL. Le juge recevait un
        // 404 et le jugeait comme une vraie page.
        return {
          type: 'ci_red',
          reason: `run ${runId} : ${err instanceof Error ? err.message : String(err)}`,
        } satisfies LoopEvent
      }
      const records = await recordCapturedPages(db, runId, deps.artifactsRoot, captures)

      // Message d'audit : trace l'URL réellement servie et par quelle voie,
      // même si la ressource est déjà relâchée quand quelqu'un relit la
      // timeline.
      await appendMessage(db, {
        runId,
        fromRole: 'system',
        toRole: 'system',
        kind: 'info',
        body:
          `${deployed.description} — ${records.length} artifact(s) capturé(s) ` +
          `pour ${pages.length} page(s).`,
        meta: {
          url: deployed.url,
          target: deps.target.kind,
          pages,
          artifactIds: records.map((r) => r.id),
        },
      })

      return { type: 'ci_green' } satisfies LoopEvent
    } finally {
      // Toujours relâcher, y compris si la capture lève. Pour l'aperçu local
      // c'est ce qui évite qu'un port et un descripteur fuient à chaque run ;
      // pour un staging réel, c'est un appel sans effet.
      await deployed.release()
    }
  }
}

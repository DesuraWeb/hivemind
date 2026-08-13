/**
 * DÉCISION D'ARCHITECTURE (Task 2, Phase 4) — CECI N'EST PAS LE STAGING RÉEL.
 *
 * Le staging réel (workflow GitHub, rsync vers cPanel) arrive à J11. En
 * attendant, cet état sert le worktree du run EN LOCAL sur un port éphémère
 * (`../../integrations/preview.ts`) pour donner au juge visuel quelque chose
 * à capturer aujourd'hui. C'est fidèle à la machine à états (l'état
 * `deploying` fait vraiment quelque chose et émet `ci_green`/`ci_red`), ça
 * n'anticipe rien de J11, et personne ne doit le prendre pour
 * l'implémentation définitive du déploiement.
 *
 * DÉCISION SUR LA DURÉE DE VIE DE L'APERÇU (question posée par le plan) —
 * l'aperçu ne survit PAS entre `deploying` et `judging` : ce handler
 * démarre le serveur, capture LUI-MÊME les pages (`pages_to_judge` rendues
 * par le garant en `framing`, lues depuis le bus) avec `capturePages`
 * (Task 1), enregistre les artifacts en base (`recordCapturedPages`), puis
 * arrête le serveur avant de rendre la main. `judging.ts` (Task 3, non
 * implémenté ici) n'aura donc besoin d'aucun serveur vivant : il relira les
 * captures déjà sur disque via la table `artifacts`.
 *
 * Pourquoi pas l'option inverse (le serveur survit jusqu'à ce que `judging`
 * l'arrête) : `deploying` et `judging` sont deux passages DISTINCTS du
 * worker (Task « stepOnce » — potentiellement à des minutes d'écart, sur un
 * job pg-boss retryable indépendamment). Si le process crashait entre les
 * deux, un serveur qui aurait survécu à `deploying` resterait orphelin
 * indéfiniment — exactement le bug de fuite de port/descripteur que le plan
 * met en garde contre. En capturant tout de suite, la durée de vie du
 * serveur ne dépasse jamais un seul `stepOnce` : un crash ne peut plus le
 * laisser tourner, `judging` peut être retenté autant de fois que
 * nécessaire sans jamais rouvrir de port, et rien de spécifique au juge
 * (Task 3, hors périmètre ici) n'a besoin d'être implémenté pour que ce
 * handler soit complet et testable seul.
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { recordCapturedPages } from '../../artifacts/store'
import type { LoopEvent } from '../../domain/run-state'
import { capturePages } from '../../integrations/playwright'
import { startStaticPreview } from '../../integrations/preview'
import type { StepHandler } from '../../jobs/run-step'
import { type StoredMessage, appendMessage, readRunMessages } from '../bus'

export interface DeployingDeps {
  /** Racine de stockage des captures (`ARTIFACTS_ROOT`), même convention que `capture.test.ts`. */
  artifactsRoot: string
}

/**
 * Ordre de recherche de la racine servable, documenté ici puisque le plan
 * demande explicitement d'en décider un et de l'écrire : `public/` d'abord
 * (convention la plus courante pour un site déjà statique — c'est le cas du
 * sandbox, cf. plan « ajouter un dossier public/ »), puis `dist/` et
 * `build/` (sorties de build les plus fréquentes, Vite et CRA
 * respectivement), et enfin la racine du worktree elle-même si aucun de ces
 * trois dossiers n'existe (site statique minimal sans étape de build). Le
 * premier candidat qui contient réellement un `index.html` gagne — un
 * dossier `dist/` vide ou un `public/` qui ne contient que des images ne
 * doit pas être choisi à la place d'une racine qui, elle, sert vraiment
 * quelque chose.
 */
const CANDIDATE_DIRS = ['public', 'dist', 'build'] as const

async function hasIndexHtml(dir: string): Promise<boolean> {
  try {
    const info = await stat(join(dir, 'index.html'))
    return info.isFile()
  } catch {
    return false
  }
}

async function findServableRoot(worktreePath: string): Promise<string | undefined> {
  for (const dir of CANDIDATE_DIRS) {
    const candidate = join(worktreePath, dir)
    if (await hasIndexHtml(candidate)) return candidate
  }
  return (await hasIndexHtml(worktreePath)) ? worktreePath : undefined
}

/** Les `pages_to_judge` rendues par le garant en `framing` (même passation que `coding.ts`/`reviewing.ts` lisent pour `acceptance_criteria`). */
function findPagesToJudge(messages: StoredMessage[]): string[] {
  const frameMessage = [...messages]
    .reverse()
    .find((m) => m.kind === 'prompt' && m.fromRole === 'garant' && m.toRole === 'dev')
  const raw = frameMessage?.meta.pages_to_judge
  const pages = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
  // Si le garant n'a rendu aucune page explicite, on capture au moins la
  // racine plutôt que de ne rien capturer du tout : `findServableRoot` vient
  // de vérifier qu'un `index.html` y répond, donc `/` est nécessairement
  // servable à ce stade.
  return pages.length > 0 ? pages : ['/']
}

/**
 * Handler réel de l'état `deploying` (Task 2, Phase 4). Voir le commentaire
 * de tête de fichier pour ce que cet état remplace (le staging réel, J11) et
 * pour la justification de la durée de vie du serveur (capture immédiate,
 * jamais survivant à ce seul passage).
 */
export function createDeployingHandler(deps: DeployingDeps): StepHandler {
  return async (db, runId) => {
    const runRow = await db
      .selectFrom('runs')
      .select(['worktree_path as worktreePath'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()

    if (!runRow.worktreePath) {
      return {
        type: 'ci_red',
        reason: `run ${runId} : aucun worktree enregistré (runs.worktree_path est vide) — rien à servir`,
      } satisfies LoopEvent
    }

    const servableRoot = await findServableRoot(runRow.worktreePath)
    if (!servableRoot) {
      return {
        type: 'ci_red',
        reason:
          `run ${runId} : aucun index.html trouvé dans public/, dist/, build/ ni à la racine ` +
          `de ${runRow.worktreePath} — rien à servir`,
      } satisfies LoopEvent
    }

    const preview = await startStaticPreview(servableRoot)
    try {
      const messages = await readRunMessages(db, runId)
      const pages = findPagesToJudge(messages)

      const artifactsDir = join(deps.artifactsRoot, runId)
      const captures = await capturePages(preview.url, pages, artifactsDir)
      const records = await recordCapturedPages(db, runId, deps.artifactsRoot, captures)

      // Message d'audit : trace l'URL réellement servie même si le serveur
      // est déjà arrêté au moment où quiconque relit la timeline — c'est le
      // `finally` ci-dessous qui s'en charge, systématiquement.
      await appendMessage(db, {
        runId,
        fromRole: 'system',
        toRole: 'system',
        kind: 'info',
        body:
          `Aperçu local servi sur ${preview.url} (racine : ${servableRoot}) — ` +
          `${records.length} artifact(s) capturé(s) pour ${pages.length} page(s).`,
        meta: {
          url: preview.url,
          servableRoot,
          pages,
          artifactIds: records.map((r) => r.id),
        },
      })

      return { type: 'ci_green' } satisfies LoopEvent
    } finally {
      // Toujours arrêter le serveur, y compris si `capturePages` ou
      // `recordCapturedPages` lève : un serveur oublié bloque un port et
      // fuit un descripteur à chaque run — sur une machine qui tourne des
      // semaines, c'est ce qui finit par tuer le process (note du plan).
      await preview.close()
    }
  }
}

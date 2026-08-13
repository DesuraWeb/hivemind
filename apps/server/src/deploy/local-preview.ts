import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { startStaticPreview } from '../integrations/preview'
import type { DeployContext, DeployResult, DeployTarget } from './types'

/**
 * CE N'EST PAS LE STAGING RÉEL — c'est la première implémentation de
 * `DeployTarget`, celle qui existait déjà en dur dans `loop/steps/deploying.ts`
 * depuis la Phase 4, désormais derrière le contrat.
 *
 * Elle sert le worktree en local sur un port éphémère, le temps d'une capture.
 * Elle reste la cible par défaut tant qu'aucun staging réel n'est configuré :
 * ça n'est pas un pis-aller honteux, c'est le comportement juste pour un
 * projet qui n'a pas encore d'hébergement de recette.
 */

/**
 * Ordre de recherche de la racine servable, inchangé depuis la Phase 4 :
 * `public/` d'abord (convention la plus courante pour un site déjà statique),
 * puis `dist/` et `build/` (sorties de Vite et CRA), et enfin la racine du
 * worktree (site statique minimal sans étape de build). Le premier candidat
 * qui contient réellement un `index.html` gagne — un `dist/` vide ou un
 * `public/` qui ne contient que des images ne doit pas être choisi à la place
 * d'une racine qui, elle, sert vraiment quelque chose.
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

export function createLocalPreviewTarget(): DeployTarget {
  return {
    kind: 'local-preview',

    async deploy(ctx: DeployContext): Promise<DeployResult> {
      const servableRoot = await findServableRoot(ctx.worktreePath)
      if (!servableRoot) {
        return {
          ok: false,
          reason:
            `run ${ctx.runId} : aucun index.html trouvé dans public/, dist/, build/ ni à la racine ` +
            `de ${ctx.worktreePath} — rien à servir`,
        }
      }

      const preview = await startStaticPreview(servableRoot)
      return {
        ok: true,
        url: preview.url,
        description: `Aperçu local servi sur ${preview.url} (racine : ${servableRoot})`,
        // Ici release() arrête vraiment le serveur : sans ça, un port et un
        // descripteur fuient à chaque run, et sur une machine qui tourne des
        // semaines c'est ce qui finit par tuer le process.
        release: () => preview.close(),
      }
    },
  }
}

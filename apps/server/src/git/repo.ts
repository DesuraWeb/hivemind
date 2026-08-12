import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface EnsureProjectRepoOptions {
  /** Racine configurée par `WORKTREES_ROOT` (voir `src/env.ts`). */
  worktreesRoot: string
  /** Slug du projet, utilisé comme nom de dossier (décision C du plan Phase 2). */
  projectSlug: string
  /** URL à cloner — un chemin de dépôt local dans les tests, une URL GitHub en prod. */
  remoteUrl: string
}

/**
 * Chemin déterministe du clone d'un projet (décision C du plan Phase 2) —
 * exporté pour les tests qui doivent pré-positionner un clone (par exemple
 * pour faire pointer `origin` vers un dépôt local jetable plutôt que
 * GitHub, sans reconstruire cette formule à la main).
 */
export function projectRepoPath(worktreesRoot: string, projectSlug: string): string {
  return join(worktreesRoot, projectSlug, 'repo')
}

/**
 * Garantit qu'un clone du dépôt projet existe sous
 * `WORKTREES_ROOT/<project-slug>/repo` et renvoie son chemin.
 *
 * Clone au premier appel ; les appels suivants font un `fetch` plutôt qu'un
 * nouveau clone, pour qu'un seul clone soit réutilisé entre tous les runs
 * d'un même projet (décision C). Les worktrees par run se branchent dessus,
 * jamais directement sur le dépôt distant.
 */
export async function ensureProjectRepo(opts: EnsureProjectRepoOptions): Promise<string> {
  const { worktreesRoot, projectSlug, remoteUrl } = opts
  const repoPath = projectRepoPath(worktreesRoot, projectSlug)

  if (existsSync(join(repoPath, '.git'))) {
    await run('git', ['fetch', '--all', '--prune'], { cwd: repoPath })
    return repoPath
  }

  await mkdir(dirname(repoPath), { recursive: true })
  await run('git', ['clone', remoteUrl, repoPath])
  return repoPath
}

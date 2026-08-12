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
  const repoPath = join(worktreesRoot, projectSlug, 'repo')

  if (existsSync(join(repoPath, '.git'))) {
    await run('git', ['fetch', '--all', '--prune'], { cwd: repoPath })
    return repoPath
  }

  await mkdir(dirname(repoPath), { recursive: true })
  await run('git', ['clone', remoteUrl, repoPath])
  return repoPath
}

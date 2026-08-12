import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Dossier des worktrees d'un projet, dérivé du chemin du clone
 * (`WORKTREES_ROOT/<project-slug>/repo` → `WORKTREES_ROOT/<project-slug>/runs`,
 * décision C du plan Phase 2). Le clone et ses worktrees sont donc toujours
 * frères, sans dépendre d'un `projectSlug` transmis séparément.
 */
function runsRoot(repoPath: string): string {
  return join(dirname(repoPath), 'runs')
}

/** Chemin déterministe du worktree d'un run donné. */
export function runWorktreePath(repoPath: string, runId: string): string {
  return join(runsRoot(repoPath), runId)
}

function runBranch(runId: string): string {
  return `run/${runId}`
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath })
    return true
  } catch {
    return false
  }
}

/**
 * Crée (ou recrée) le worktree d'un run sur la branche `run/<runId>`.
 *
 * `git worktree prune` est appelé systématiquement avant toute tentative :
 * après un crash du process, le répertoire du worktree peut avoir disparu
 * sans que git en soit informé, auquel cas il refuse tout nouveau
 * `git worktree add` sur la même branche en la croyant encore extraite
 * ailleurs. Sans ce prune, un run interrompu serait bloqué pour toujours.
 *
 * Si la branche `run/<runId>` existe déjà (reprise après crash), le worktree
 * est rattaché dessus — le travail déjà commité est conservé. Sinon, elle est
 * créée depuis la branche par défaut du dépôt.
 */
export async function addRunWorktree(repoPath: string, runId: string): Promise<string> {
  const worktreePath = runWorktreePath(repoPath, runId)
  const branch = runBranch(runId)

  await run('git', ['worktree', 'prune'], { cwd: repoPath })

  if (await branchExists(repoPath, branch)) {
    await run('git', ['worktree', 'add', worktreePath, branch], { cwd: repoPath })
  } else {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath })
    const defaultBranch = stdout.trim()
    await run('git', ['worktree', 'add', '-b', branch, worktreePath, defaultBranch], {
      cwd: repoPath,
    })
  }

  return worktreePath
}

/**
 * Supprime le worktree d'un run et son répertoire. Idempotent : un second
 * appel (ou un appel sur un worktree déjà disparu) ne lève pas — l'appelant
 * n'a pas à savoir si le nettoyage a déjà eu lieu.
 */
export async function removeRunWorktree(repoPath: string, runId: string): Promise<void> {
  const worktreePath = runWorktreePath(repoPath, runId)

  try {
    await run('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath })
  } catch {
    // Rien à retirer administrativement (déjà supprimé, ou jamais créé) :
    // ce n'est pas une erreur, `rm` et `prune` ci-dessous suffisent à finir
    // le nettoyage dans tous les cas.
  }

  await rm(worktreePath, { recursive: true, force: true })
  await run('git', ['worktree', 'prune'], { cwd: repoPath })
}

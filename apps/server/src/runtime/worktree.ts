import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface DisposableWorktree {
  path: string
  dispose(): Promise<void>
}

/**
 * Crée un dépôt git jetable dans /tmp, avec un commit initial.
 * Utilisé par le smoke test de la Task 10 ; les worktrees rattachés à un vrai
 * dépôt arrivent en Phase 2 avec le moteur de boucles.
 */
export async function createThrowawayRepo(): Promise<DisposableWorktree> {
  const path = await mkdtemp(join(tmpdir(), 'silithid-smoke-'))
  await run('git', ['init', '-b', 'main'], { cwd: path })
  await run('git', ['config', 'user.email', 'silithid@local'], { cwd: path })
  await run('git', ['config', 'user.name', 'silithid'], { cwd: path })
  await run('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: path })
  return {
    path,
    dispose: () => rm(path, { recursive: true, force: true }),
  }
}

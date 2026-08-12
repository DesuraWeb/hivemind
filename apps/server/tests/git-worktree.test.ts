import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { ensureProjectRepo } from '../src/git/repo'
import { addRunWorktree, removeRunWorktree, runWorktreePath } from '../src/git/worktree'
import { type DisposableWorktree, createThrowawayRepo } from '../src/runtime/worktree'

const run = promisify(execFile)

// Ces tests créent des dépôts et des worktrees réels sous /tmp : on les
// démonte systématiquement, dans l'ordre inverse de création, pour ne rien
// laisser traîner sur la machine même si une assertion échoue en cours de test.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

async function tempWorktreesRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'chapo-worktrees-root-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function sourceRepo(): Promise<DisposableWorktree> {
  const repo = await createThrowawayRepo()
  cleanups.push(repo.dispose)
  return repo
}

function randomRunId(): string {
  return `test-${Math.random().toString(36).slice(2, 10)}`
}

test('ensureProjectRepo clone la premiere fois, reutilise ensuite', async () => {
  const source = await sourceRepo()
  const worktreesRoot = await tempWorktreesRoot()

  const repoPath = await ensureProjectRepo({
    worktreesRoot,
    projectSlug: 'acme',
    remoteUrl: source.path,
  })

  // Le clone existe et a bien récupéré l'historique du dépôt source.
  const firstLog = await run('git', ['log', '--oneline'], { cwd: repoPath })
  expect(firstLog.stdout.trim().split('\n')).toHaveLength(1)

  // Marqueur non versionné : si le deuxième appel re-clonait (donc recréait
  // le répertoire), ce fichier disparaîtrait. S'il reste, c'est que
  // l'implémentation a réutilisé le clone existant plutôt que d'en refaire un.
  const marker = join(repoPath, '.reused-marker')
  await writeFile(marker, 'still here')

  // Nouveau commit côté source, pour distinguer "reused sans rien faire" de
  // "reused et a bien fetch".
  await writeFile(join(source.path, 'new-file.txt'), 'contenu ajouté après le premier clone')
  await run('git', ['add', 'new-file.txt'], { cwd: source.path })
  await run('git', ['commit', '-m', 'second commit'], { cwd: source.path })

  const repoPathAgain = await ensureProjectRepo({
    worktreesRoot,
    projectSlug: 'acme',
    remoteUrl: source.path,
  })

  expect(repoPathAgain).toBe(repoPath)
  await expect(readFile(marker, 'utf8')).resolves.toBe('still here') // pas de nouveau clone

  // Un fetch a bien eu lieu : le commit ajouté côté source est visible via la
  // branche de suivi distante, même si le worktree local n'a pas bougé.
  const { stdout: defaultBranch } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoPath,
  })
  const remoteLog = await run('git', ['log', `origin/${defaultBranch.trim()}`, '--oneline'], {
    cwd: repoPath,
  })
  expect(remoteLog.stdout).toContain('second commit')
})

test('addRunWorktree cree un worktree sur une branche run/<runId> depuis la branche par defaut', async () => {
  const source = await sourceRepo()
  const worktreesRoot = await tempWorktreesRoot()
  const repoPath = await ensureProjectRepo({
    worktreesRoot,
    projectSlug: 'acme',
    remoteUrl: source.path,
  })

  const runId = randomRunId()
  const worktreePath = await addRunWorktree(repoPath, runId)

  expect(worktreePath).toBe(runWorktreePath(repoPath, runId))

  const { stdout: branch } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: worktreePath,
  })
  expect(branch.trim()).toBe(`run/${runId}`)

  // Contenu du commit initial bien présent dans le worktree.
  const { stdout: log } = await run('git', ['log', '--oneline'], { cwd: worktreePath })
  expect(log.trim().split('\n')).toHaveLength(1)
})

test('deux worktrees de deux runs coexistent sans interference', async () => {
  const source = await sourceRepo()
  const worktreesRoot = await tempWorktreesRoot()
  const repoPath = await ensureProjectRepo({
    worktreesRoot,
    projectSlug: 'acme',
    remoteUrl: source.path,
  })

  const runIdA = randomRunId()
  const runIdB = randomRunId()
  const worktreeA = await addRunWorktree(repoPath, runIdA)
  const worktreeB = await addRunWorktree(repoPath, runIdB)

  expect(worktreeA).not.toBe(worktreeB)

  await writeFile(join(worktreeA, 'only-in-a.txt'), 'run A')
  await writeFile(join(worktreeB, 'only-in-b.txt'), 'run B')

  await expect(readFile(join(worktreeA, 'only-in-b.txt'), 'utf8')).rejects.toThrow()
  await expect(readFile(join(worktreeB, 'only-in-a.txt'), 'utf8')).rejects.toThrow()
  await expect(readFile(join(worktreeA, 'only-in-a.txt'), 'utf8')).resolves.toBe('run A')
  await expect(readFile(join(worktreeB, 'only-in-b.txt'), 'utf8')).resolves.toBe('run B')

  const { stdout: branchA } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: worktreeA,
  })
  const { stdout: branchB } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: worktreeB,
  })
  expect(branchA.trim()).toBe(`run/${runIdA}`)
  expect(branchB.trim()).toBe(`run/${runIdB}`)
})

test('removeRunWorktree supprime worktree et repertoire, un second appel ne leve pas', async () => {
  const source = await sourceRepo()
  const worktreesRoot = await tempWorktreesRoot()
  const repoPath = await ensureProjectRepo({
    worktreesRoot,
    projectSlug: 'acme',
    remoteUrl: source.path,
  })
  const runId = randomRunId()
  const worktreePath = await addRunWorktree(repoPath, runId)

  await removeRunWorktree(repoPath, runId)

  await expect(stat(worktreePath)).rejects.toThrow() // répertoire bien supprimé
  const { stdout: list } = await run('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath })
  expect(list).not.toContain(worktreePath)

  // Idempotence : un deuxième appel sur un worktree déjà supprimé ne lève pas.
  await expect(removeRunWorktree(repoPath, runId)).resolves.toBeUndefined()
})

test('un worktree dont le repertoire a ete supprime a la main est recuperable apres un crash', async () => {
  const source = await sourceRepo()
  const worktreesRoot = await tempWorktreesRoot()
  const repoPath = await ensureProjectRepo({
    worktreesRoot,
    projectSlug: 'acme',
    remoteUrl: source.path,
  })
  const runId = randomRunId()
  const worktreePath = await addRunWorktree(repoPath, runId)

  // Le dev a déjà commité du travail sur la branche du run avant le crash.
  await writeFile(join(worktreePath, 'work-in-progress.txt'), 'travail avant crash')
  await run('git', ['add', 'work-in-progress.txt'], { cwd: worktreePath })
  await run('git', ['commit', '-m', 'travail du dev avant le crash'], { cwd: worktreePath })

  // Simule le crash : le process meurt, le répertoire du worktree disparaît
  // (ex. disque éphémère nettoyé), mais le dépôt et la branche run/<runId>
  // survivent puisqu'ils vivent dans le clone projet, pas dans le worktree.
  await rm(worktreePath, { recursive: true, force: true })

  // `git worktree add` sur cette branche échouerait indéfiniment sans prune :
  // git la considère toujours "checked out" à un chemin qui n'existe plus.
  // La preuve du comportement 5 est que ce second appel à addRunWorktree
  // réussit ET restitue le travail déjà commité, pas seulement qu'il ne lève
  // pas d'erreur.
  const recoveredPath = await addRunWorktree(repoPath, runId)

  expect(recoveredPath).toBe(worktreePath)
  const { stdout: branch } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: recoveredPath,
  })
  expect(branch.trim()).toBe(`run/${runId}`) // toujours la même branche, pas une nouvelle

  await expect(readFile(join(recoveredPath, 'work-in-progress.txt'), 'utf8')).resolves.toBe(
    'travail avant crash',
  ) // le commit d'avant-crash n'a pas été perdu
})

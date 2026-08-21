import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { reposVerrouilles, withRepoLock } from '../src/git/lock'
import { ensureProjectRepo } from '../src/git/repo'
import { addRunWorktree, removeRunWorktree, runWorktreePath } from '../src/git/worktree'
import { type DisposableWorktree, createThrowawayRepo } from '../src/runtime/worktree'

const run = promisify(execFile)

/**
 * Trois boucles peuvent avancer en même temps (`LOOP_CONCURRENCY`). Deux
 * d'entre elles peuvent porter sur le MÊME projet, donc sur le même clone —
 * et git ne supporte pas deux `worktree add` concurrents sur un dépôt.
 *
 * Ces tests lancent de vraies opérations git en parallèle. Vérifié en
 * désactivant la file (`git/lock.ts`) : le test du clone échoue alors
 * franchement — « could not create work tree dir : File exists », puis un
 * ENOTEMPTY au nettoyage. La collision n'est donc pas théorique.
 *
 * Celui des trois worktrees, lui, passe même sans la file sur cette machine :
 * git sérialise déjà ses propres verrous et les trois ajouts sont trop courts
 * pour se croiser à coup sûr. Il reste utile comme garde — un `prune` qui
 * désenregistrerait le worktree d'un voisin le ferait tomber — mais il ne
 * reproduit pas la panne, et ce serait malhonnête de le laisser croire.
 */

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

async function tempWorktreesRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'silithid-concurrence-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function sourceRepo(): Promise<DisposableWorktree> {
  const repo = await createThrowawayRepo()
  cleanups.push(repo.dispose)
  return repo
}

test('trois runs du même projet créent leurs worktrees sans se marcher dessus', async () => {
  const source = await sourceRepo()
  const worktreesRoot = await tempWorktreesRoot()
  const repoPath = await ensureProjectRepo({
    worktreesRoot,
    projectSlug: 'acme',
    remoteUrl: source.path,
  })

  const runIds = ['run-a', 'run-b', 'run-c']
  const chemins = await Promise.all(runIds.map((id) => addRunWorktree(repoPath, id)))

  expect(chemins).toEqual(runIds.map((id) => runWorktreePath(repoPath, id)))
  for (const chemin of chemins) {
    expect((await stat(chemin)).isDirectory()).toBe(true)
  }

  // Vu de git : trois worktrees enregistrés en plus du dépôt principal.
  // Le `prune` que chaque ajout exécute n'a désenregistré aucun voisin.
  const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath })
  const enregistres = stdout.split('\n').filter((l) => l.startsWith('worktree '))
  expect(enregistres).toHaveLength(4)

  for (const id of runIds) await removeRunWorktree(repoPath, id)
})

test('deux runs qui démarrent ensemble sur un projet jamais cloné ne clonent qu’une fois', async () => {
  const source = await sourceRepo()
  const worktreesRoot = await tempWorktreesRoot()

  const opts = { worktreesRoot, projectSlug: 'jamais-clone', remoteUrl: source.path }
  const [a, b] = await Promise.all([ensureProjectRepo(opts), ensureProjectRepo(opts)])

  expect(a).toBe(b)
  // Le second appel a trouvé le clone du premier et s'est contenté d'un fetch :
  // sans la file, il aurait relancé un `git clone` vers un dossier non vide.
  const { stdout } = await run('git', ['log', '--oneline'], { cwd: a })
  expect(stdout.trim().length).toBeGreaterThan(0)
})

test('un échec ne fige pas la file du dépôt', async () => {
  const ordre: string[] = []

  const echoue = withRepoLock('/depot/x', async () => {
    ordre.push('premier')
    throw new Error('boum')
  })
  const suivant = withRepoLock('/depot/x', async () => {
    ordre.push('second')
    return 'ok'
  })

  await expect(echoue).rejects.toThrow('boum')
  // Le piège classique de ce motif : une exception non absorbée figerait le
  // dépôt pour toute la vie du process.
  expect(await suivant).toBe('ok')
  expect(ordre).toEqual(['premier', 'second'])
})

test('deux dépôts différents ne s’attendent jamais', async () => {
  let debloquerA: (() => void) | undefined
  const bloque = new Promise<void>((resolve) => {
    debloquerA = resolve
  })

  const a = withRepoLock('/depot/a', async () => {
    await bloque
    return 'a'
  })
  // B ne doit pas attendre A : s'il attendait, ce `await` ne rendrait jamais
  // la main et le test expirerait.
  expect(await withRepoLock('/depot/b', async () => 'b')).toBe('b')

  debloquerA?.()
  expect(await a).toBe('a')
})

test('la file se vide d’elle-même quand plus rien n’attend', async () => {
  const avant = reposVerrouilles()
  await withRepoLock('/depot/ephemere', async () => 'fait')
  // Une entrée par dépôt jamais retouché resterait en mémoire pour toujours.
  await new Promise((resolve) => setImmediate(resolve))
  expect(reposVerrouilles()).toBe(avant)
})

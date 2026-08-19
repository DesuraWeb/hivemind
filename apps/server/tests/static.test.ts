import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { expect, test } from 'vitest'
import { resolveInRoot } from '../src/api/static'

/**
 * La traversée de répertoire est le seul vrai risque d'un serveur de fichiers
 * écrit à la main. On teste l'INVARIANT — rien ne sort jamais de la racine —
 * plutôt qu'une liste de cas devinés.
 *
 * Deux mécanismes s'y emploient, et il a fallu les mesurer pour les décrire
 * correctement : sur un chemin absolu, `normalize` écrête les `..` à la racine
 * (`/../.env` devient `/.env`, donc `dist/.env` — dedans, pas dehors) ; sur un
 * chemin relatif, c'est la comparaison `startsWith` qui refuse. Les premiers
 * tests écrits ici affirmaient `null` sur les cas absolus : ils décrivaient une
 * protection qui n'existe pas, alors que la vraie tient.
 */

const ROOT = '/srv/dist'

/** Ce qui compte : dedans, ou rien. Jamais ailleurs. */
function estContenu(resultat: string | null): boolean {
  if (resultat === null) return true
  const r = resolve(ROOT)
  return resultat === r || resultat.startsWith(r + sep)
}

test('AUCUNE entrée ne résout hors de la racine', () => {
  const attaques = [
    '/../.env',
    '/../../etc/passwd',
    '/assets/../../.env',
    '/%2e%2e%2f.env',
    '/....//....//.env',
    '/./../../.ssh/id_rsa',
    '../.env',
    '../../etc/passwd',
    'assets/../../../.env',
    '/index.html\0.png',
    '/%zz',
    '//etc/passwd',
    '/.git/config',
  ]
  for (const url of attaques) {
    const out = resolveInRoot(ROOT, url)
    expect(estContenu(out), `${url} → ${out}`).toBe(true)
  }
})

test('un chemin relatif qui remonte est REFUSÉ, pas écrêté', () => {
  // Ici `normalize` ne peut rien : c'est la comparaison de préfixe qui tient.
  expect(resolveInRoot(ROOT, '../.env')).toBeNull()
  // Et le séparateur compte : `/srv/dist-secret` commence par `/srv/dist`.
  expect(resolveInRoot(ROOT, '../dist-secret/cle.pem')).toBeNull()
})

test('un octet nul ou un pourcentage invalide sont refusés d’emblée', () => {
  expect(resolveInRoot(ROOT, '/index.html\0.png')).toBeNull()
  expect(resolveInRoot(ROOT, '/%zz')).toBeNull()
})

test('les chemins légitimes passent', () => {
  expect(resolveInRoot(ROOT, '/index.html')).toBe(join(ROOT, 'index.html'))
  expect(resolveInRoot(ROOT, '/assets/app-a1b2c3d4.js')).toBe(
    join(ROOT, 'assets', 'app-a1b2c3d4.js'),
  )
  expect(resolveInRoot(ROOT, '/')).toBe(ROOT)
})

test('sur un vrai dossier, un fichier hors racine reste inatteignable', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'silithid-prod-'))
  const root = join(parent, 'dist')
  await mkdtemp(join(tmpdir(), 'x-'))
  await writeFile(join(parent, 'secret.txt'), 'ne doit pas sortir', 'utf8')

  for (const url of ['/../secret.txt', '../secret.txt', '/%2e%2e/secret.txt']) {
    const out = resolveInRoot(root, url)
    const dedans = out === null || out.startsWith(resolve(root) + sep) || out === resolve(root)
    expect(dedans, `${url} → ${out}`).toBe(true)
  }
})

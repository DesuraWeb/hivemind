import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Un aller-retour SSH, script sur l'entrée standard.
 *
 * Extrait de `deploy/ssh-git.ts` quand l'exploitation (Phase 6) en a eu besoin
 * à son tour. Les deux appelants partagent exactement les mêmes précautions,
 * et les dupliquer aurait voulu dire les corriger deux fois le jour où l'une
 * d'elles se révèle insuffisante.
 *
 * ## Ce qui est délibéré ici, et pourquoi
 *
 * - **Le script passe par stdin, jamais en argument.** Les arguments d'un
 *   processus sont lisibles par n'importe qui via `ps` sur la machine.
 * - **La clé privée n'existe sur disque que le temps de l'appel**, en 0600,
 *   dans un répertoire temporaire effacé dans un `finally`. La garder quelque
 *   part de durable serait la sortir du coffre pour de bon.
 * - **Pas de `StrictHostKeyChecking=no`.** Accepter n'importe quelle clé
 *   d'hôte, c'est accepter un homme du milieu. Le serveur doit être dans le
 *   `known_hosts` de la machine, posé une fois à la mise en service.
 * - **`BatchMode=yes`** : jamais d'invite interactive. Un ssh qui attendrait
 *   une passphrase bloquerait un worker pour toujours.
 *
 * ## Ce que ce module n'est PAS
 *
 * Ce n'est pas une surface d'agent. Aucun rôle ne l'atteint : il est appelé
 * par du code serveur qui a déjà décidé quoi exécuter. Le catalogue borné
 * d'opérations (`ops/operations.ts`) est la seule chose qu'un agent compose,
 * et c'est le serveur qui la traduit en script.
 */

export interface SshTarget {
  hote: string
  utilisateur: string
  port?: number
  /** Clé privée OpenSSH, lue depuis le coffre par l'appelant. */
  clePrivee: string
}

export interface SshResult {
  code: number
  stdout: string
  stderr: string
}

function runWithStdin(
  command: string,
  args: string[],
  input: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.write(input)
    child.stdin.end()
  })
}

/** Une clé sans saut de ligne final fait échouer ssh avec « invalid format ». */
function terminerParUnSautDeLigne(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`
}

export async function runSshScript(cible: SshTarget, script: string): Promise<SshResult> {
  const keyDir = await mkdtemp(join(tmpdir(), 'silithid-ssh-'))
  const keyPath = join(keyDir, 'id')
  await writeFile(keyPath, terminerParUnSautDeLigne(cible.clePrivee), { mode: 0o600 })

  try {
    return await runWithStdin(
      'ssh',
      [
        '-i',
        keyPath,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'BatchMode=yes',
        ...(cible.port && cible.port !== 22 ? ['-p', String(cible.port)] : []),
        `${cible.utilisateur}@${cible.hote}`,
        'bash -s',
      ],
      script,
    )
  } finally {
    // La clé quitte le disque quoi qu'il arrive.
    await rm(keyDir, { recursive: true, force: true })
  }
}

/**
 * Échappement pour le shell distant : guillemets simples, avec la séquence
 * classique pour un guillemet simple littéral. Le SEUL endroit du code où une
 * valeur venue d'ailleurs devient du texte de commande.
 */
export function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

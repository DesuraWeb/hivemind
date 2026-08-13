import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsStore } from '../settings/store'
import type { DeployContext, DeployResult, DeployTarget } from './types'

/**
 * Lance une commande en lui passant un script sur l'entrée standard.
 *
 * Passer le script par stdin plutôt qu'en argument n'est pas un détail de
 * style : les arguments d'un processus sont lisibles par n'importe qui via
 * `ps` sur la machine. Le script ne contient pas de secret aujourd'hui, mais
 * c'est le genre d'invariant qu'on pose avant d'en avoir besoin.
 */
function runWithStdin(
  command: string,
  args: string[],
  input: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
    child.stdin.write(input)
    child.stdin.end()
  })
}

/**
 * Le staging réel (Phase 5, Task 3) : un sous-domaine par projet sur le VPS
 * OVH, alimenté depuis GitHub.
 *
 * ## Pourquoi cette voie et pas une autre
 *
 * C'est le workflow que Florian pratique déjà : on pousse sur GitHub, le
 * serveur récupère. `coding.ts` a justement déjà poussé la branche du run
 * (`git push -u origin HEAD:run/<id>`) avant que cet état ne soit atteint —
 * le code EST chez GitHub quand on arrive ici. Déployer se réduit donc à
 * demander au serveur d'aller le chercher. Rien de nouveau à apprendre, et la
 * même voie reste disponible pour les vieux projets hébergés ailleurs.
 *
 * ## Un sous-domaine par projet, pas par run
 *
 * `<slug>.<domaine de staging>` — stable dans le temps. C'est ce que le pack
 * affiche (`staging: "stg.lekoin.fr"`), c'est ce que le gate de mise en prod
 * appelle « staging vérifié », et c'est une URL que Florian peut garder
 * ouverte pendant que la boucle itère. Un sous-domaine par run donnerait une
 * URL différente à chaque tour, donc un onglet à rouvrir à chaque fois.
 *
 * Un enregistrement DNS joker (`*.stg.silithid.com`) suffit : un projet neuf
 * a son URL à la seconde où il existe, sans que personne ne touche à la DNS.
 *
 * ## Ce que ce module ne fait PAS, et ne fera jamais
 *
 * **Il n'écrit aucune configuration serveur.** Pas de vhost nginx, pas de
 * `.htaccess`, pas de `php.ini`, pas de cron. Règle dure de Florian, et elle
 * vaut ici pour une deuxième raison : un agent qui peut réécrire la
 * configuration d'un serveur peut y ouvrir une porte. La mise en place du
 * vhost joker, du certificat et de la protection par mot de passe est un
 * geste humain, fait une fois — voir `docs/exploitation/staging.md`.
 *
 * Ce module ne fait que deux choses sur le serveur : cloner ou mettre à jour
 * un dépôt dans un répertoire, et poser un `robots.txt`.
 *
 * ## La protection contre l'indexation n'est pas optionnelle
 *
 * Un staging public, c'est le site d'un client dupliqué sur un autre domaine.
 * La règle la plus dure de Florian porte précisément là-dessus : ne jamais
 * abîmer le référencement d'un client. On pose donc un `robots.txt` bloquant à
 * chaque déploiement, **en plus** de l'authentification HTTP posée côté vhost.
 * Les deux, jamais l'un ou l'autre : un `robots.txt` n'empêche pas la lecture,
 * une authentification n'empêche pas un lien de fuir.
 */

/** Réglages publics de la cible. Modifiables sans redéploiement. */
export const STAGING_SETTINGS_KEYS = {
  host: 'deploy.ssh.host',
  user: 'deploy.ssh.user',
  /** Répertoire racine sur le VPS ; un sous-répertoire par projet y est créé. */
  root: 'deploy.ssh.root',
  /** Domaine de staging, ex. `stg.silithid.com`. L'URL devient `<slug>.<domaine>`. */
  domain: 'deploy.staging_domain',
} as const

/** Clé privée SSH. Dans le coffre, jamais dans un réglage ni dans le dépôt. */
export const STAGING_KEY_SECRET = 'deploy.ssh.private_key'

export interface StagingConfig {
  host: string
  user: string
  root: string
  domain: string
  privateKey: string
}

/**
 * Lit la configuration, ou explique ce qui manque.
 *
 * Trois cas distincts, jamais confondus : rien de configuré (le staging n'est
 * pas en service, on retombe sur l'aperçu local), tout configuré, ou
 * partiellement configuré — et ce dernier cas **lève**. Retomber silencieusement
 * sur l'aperçu local avec une configuration à moitié posée ferait juger le
 * juge sur une page locale en croyant regarder le staging. Même arbitrage que
 * `createGmailAccount`.
 */
export async function readStagingConfig(settings: SettingsStore): Promise<StagingConfig | null> {
  const publics = await Promise.all(
    Object.entries(STAGING_SETTINGS_KEYS).map(
      async ([name, key]) => [name, await settings.get<string>(key)] as const,
    ),
  )
  const privateKey = await settings.getSecret(STAGING_KEY_SECRET)

  const all = [...publics, ['privateKey', privateKey] as const]
  const present = all.filter(([, v]) => typeof v === 'string' && v.length > 0)

  if (present.length === 0) return null
  if (present.length !== all.length) {
    const missing = all
      .filter(([, v]) => typeof v !== 'string' || v.length === 0)
      .map(([name]) =>
        name === 'privateKey'
          ? STAGING_KEY_SECRET
          : STAGING_SETTINGS_KEYS[name as keyof typeof STAGING_SETTINGS_KEYS],
      )
    throw new Error(`configuration de staging incomplète, il manque : ${missing.join(', ')}`)
  }

  return Object.fromEntries(all) as unknown as StagingConfig
}

/**
 * `robots.txt` posé à chaque déploiement. Volontairement une constante et non
 * un gabarit : il n'y a rien à personnaliser, et un jour où quelqu'un voudra
 * « juste autoriser un crawler » sur un staging, il faudra que ce soit une
 * modification visible de ce fichier.
 */
const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n'

export interface SshGitTargetDeps {
  config: StagingConfig
  /** Dépôt GitHub du projet (`owner/name`) et branche du run à déployer. */
  resolveSource: (ctx: DeployContext) => Promise<{ repoFullName: string; branch: string } | null>
}

/** Nom d'hôte du staging d'un projet. Exporté : le gate prod et l'UI l'affichent. */
export function stagingUrl(domain: string, projectSlug: string): string {
  return `https://${projectSlug}.${domain}`
}

export function createSshGitTarget(deps: SshGitTargetDeps): DeployTarget {
  const { config } = deps

  return {
    kind: 'ssh-git',

    async deploy(ctx: DeployContext): Promise<DeployResult> {
      const source = await deps.resolveSource(ctx)
      if (!source) {
        return {
          ok: false,
          reason: `run ${ctx.runId} : aucune branche poussée pour ce run, rien à récupérer côté serveur`,
        }
      }

      // La clé privée n'existe sur disque que le temps du déploiement, dans un
      // répertoire temporaire à permissions restreintes. La garder en clair
      // quelque part de durable serait la sortir du coffre pour de bon.
      const keyDir = await mkdtemp(join(tmpdir(), 'silithid-deploy-'))
      const keyPath = join(keyDir, 'id')
      await writeFile(keyPath, ensureTrailingNewline(config.privateKey), { mode: 0o600 })

      const dir = `${config.root}/${ctx.projectSlug}`
      const repoUrl = `https://github.com/${source.repoFullName}.git`

      // Un seul aller-retour SSH plutôt qu'un par commande : chaque connexion
      // coûte une poignée de main, et un déploiement à moitié fait entre deux
      // connexions serait plus difficile à diagnostiquer qu'un script qui
      // échoue d'un bloc. `set -e` fait échouer au premier problème.
      const script = [
        'set -e',
        `mkdir -p ${sh(dir)}`,
        `if [ ! -d ${sh(`${dir}/.git`)} ]; then git clone ${sh(repoUrl)} ${sh(dir)}; fi`,
        `cd ${sh(dir)}`,
        `git fetch --depth 1 origin ${sh(source.branch)}`,
        // `reset --hard` et non `pull` : le staging est un miroir, jamais une
        // copie de travail. Une modification faite à la main sur le serveur ne
        // doit pas pouvoir bloquer un déploiement par un conflit.
        'git reset --hard FETCH_HEAD',
        'git clean -fd',
        // Posé APRÈS le clean, sinon il serait balayé par celui-ci.
        `printf '%s' ${sh(ROBOTS_TXT)} > ${sh(`${dir}/robots.txt`)}`,
      ].join('\n')

      try {
        const { code, stderr } = await runWithStdin(
          'ssh',
          [
            '-i',
            keyPath,
            '-o',
            'IdentitiesOnly=yes',
            // Pas de `StrictHostKeyChecking=no` : accepter n'importe quelle clé
            // d'hôte, c'est accepter un homme du milieu. Le serveur doit être
            // dans le `known_hosts` de la machine, posé une fois à la mise en
            // service (voir la doc d'exploitation).
            '-o',
            'BatchMode=yes',
            `${config.user}@${config.host}`,
            'bash -s',
          ],
          script,
        )
        if (code !== 0) {
          // La sortie d'erreur telle quelle : c'est elle qui dit si c'est un
          // refus d'authentification, un dépôt privé, ou un disque plein.
          return {
            ok: false,
            reason: `déploiement sur ${config.host} échoué (code ${code}) : ${stderr.trim()}`,
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, reason: `déploiement sur ${config.host} impossible : ${message}` }
      } finally {
        // La clé quitte le disque quoi qu'il arrive.
        await rm(keyDir, { recursive: true, force: true })
      }

      const url = stagingUrl(config.domain, ctx.projectSlug)
      return {
        ok: true,
        url,
        description: `Déployé sur ${url} depuis ${source.repoFullName}@${source.branch}`,
        // Un staging RESTE debout : c'est tout son intérêt. `release()` ne
        // défait rien, contrairement à l'aperçu local qui arrête son serveur.
        release: async () => {},
      }
    },
  }
}

function ensureTrailingNewline(key: string): string {
  return key.endsWith('\n') ? key : `${key}\n`
}

/**
 * Échappement pour un shell POSIX. Les valeurs viennent des réglages et de la
 * base : elles ne sont pas hostiles, mais un slug ou un chemin contenant une
 * apostrophe casserait le script sans ça, et l'écart entre « casse » et
 * « exécute autre chose » est mince.
 */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

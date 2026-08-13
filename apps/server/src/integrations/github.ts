import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Authentification GitHub (Task 10, correction actée après la rédaction du
 * plan `2026-08-12-phase2-moteur-de-boucles.md` — elle prime sur le §Task 10
 * Step 2 qui prévoyait un PAT fine-grained en `settings`).
 *
 * Ce module ne lit ni ne construit de jeton depuis `settings` : il délègue
 * entièrement au CLI `gh`, déjà authentifié sur la machine qui fait tourner
 * Silithid (compte `DesuraWeb`, scopes `repo` + `workflow`, `gh auth
 * status`). C'est cohérent avec le reste du sprint : l'auth agents s'appuie
 * de la même façon sur la session `claude` locale plutôt que sur une clé API
 * stockée, plutôt que de traiter GitHub différemment. `git push` bénéficie du
 * même mécanisme : `gh` installe un credential helper (`osxkeychain` ici) que
 * `git` interroge de lui-même sur une URL `https://github.com/...` — aucun
 * jeton ne transite par ce fichier ni par `git/repo.ts`.
 *
 * **Note J15** : agents et GitHub basculeront tous deux sur des jetons dédiés
 * à J15 (le stockage chiffré existe déjà — `src/settings/store.ts`,
 * `setSecret`/`getSecret`). Ce jour-là, ce fichier remplace ses appels
 * `execFile('gh', ...)` par des appels HTTP authentifiés par le jeton stocké
 * (`@octokit/rest` ou `fetch` nu) — l'API exposée ici
 * (`createPullRequest`/`getPullRequest`/`listChecks`) ne change pas, seuls
 * les appelants sont protégés de la bascule.
 *
 * Toujours `execFile` avec un tableau d'arguments, jamais `exec` avec une
 * chaîne : titres de PR, corps et noms de branche viennent d'une sortie
 * d'agent ou de la base, jamais d'un littéral de confiance — une chaîne
 * shell interpolée serait une injection de commande ouverte.
 */

export interface CreatePullRequestOptions {
  /** `owner/repo`. */
  repoFullName: string
  /** Branche source, déjà poussée sur `origin`. */
  head: string
  /** Branche cible. Par défaut, celle configurée côté GitHub pour le dépôt. */
  base?: string
  title: string
  body: string
  /** Labels `silithid:run-<id>` (brief §10) — créés au besoin, jamais supposés déjà exister. */
  labels?: string[]
}

export interface PullRequestSummary {
  number: number
  url: string
  state: string
  title: string
}

export interface PullRequestFile {
  /** Chemin actuel du fichier dans le dépôt. */
  path: string
  /** Présent uniquement pour un fichier renommé (`status === 'renamed'`). */
  previousPath?: string
  /** brut GitHub : added|removed|modified|renamed|copied|changed|unchanged. */
  status: string
}

export interface CheckRun {
  name: string
  /** brut GitHub : `queued`, `in_progress`, `completed`, ... */
  state: string
  /** catégorisation `gh` : `pass` | `fail` | `pending` | `skipping` | `cancel`. */
  bucket: string
  link: string
}

/**
 * Garantit qu'un label existe avant de le poser sur une PR — `gh pr create
 * --label` échoue sec sur un label absent du dépôt, il ne le crée jamais lui-
 * même. `--force` rend l'appel idempotent : un label déjà présent est laissé
 * (couleur/description réécrites à l'identique), jamais une erreur.
 */
async function ensureLabel(repoFullName: string, label: string): Promise<void> {
  await run('gh', [
    'label',
    'create',
    label,
    '--repo',
    repoFullName,
    '--color',
    '5319e7',
    '--description',
    'Géré par Silithid — ne pas éditer à la main.',
    '--force',
  ])
}

/**
 * Ouvre une pull request réelle sur GitHub via `gh pr create`, après avoir
 * garanti l'existence de chaque label demandé. Renvoie le résumé lu via
 * `getPullRequest` plutôt que de parser la sortie texte de `create` au-delà
 * du numéro : une seule façon de lire l'état d'une PR dans ce module.
 */
export async function createPullRequest(
  opts: CreatePullRequestOptions,
): Promise<PullRequestSummary> {
  const labels = opts.labels ?? []
  for (const label of labels) {
    await ensureLabel(opts.repoFullName, label)
  }

  const args = [
    'pr',
    'create',
    '--repo',
    opts.repoFullName,
    '--head',
    opts.head,
    '--title',
    opts.title,
    '--body',
    opts.body,
  ]
  if (opts.base) args.push('--base', opts.base)
  for (const label of labels) args.push('--label', label)

  const { stdout } = await run('gh', args)
  // `gh pr create` imprime l'URL de la PR créée sur la dernière ligne de
  // stdout (les lignes précédentes peuvent contenir des avertissements, ex.
  // sur les checks manquants).
  const url = stdout.trim().split('\n').pop()?.trim()
  const match = url?.match(/\/pull\/(\d+)/)
  if (!match) {
    throw new Error(`gh pr create n'a pas renvoyé d'URL de PR exploitable (stdout : ${stdout})`)
  }

  return getPullRequest(opts.repoFullName, Number(match[1]))
}

export async function getPullRequest(
  repoFullName: string,
  number: number,
): Promise<PullRequestSummary> {
  const { stdout } = await run('gh', [
    'pr',
    'view',
    String(number),
    '--repo',
    repoFullName,
    '--json',
    'number,url,state,title',
  ])
  return JSON.parse(stdout) as PullRequestSummary
}

/**
 * Liste les fichiers modifiés d'une PR, renommages compris (Task 6, Phase 4 —
 * le 4ᵉ gate). `gh pr view --json files` (utilisé par `getPullRequest`
 * ailleurs dans ce module) passe par le point GraphQL `PullRequestChangedFile`,
 * qui n'expose que `path` — vérifié contre le schéma
 * (`gh api graphql -f query='{ __type(name: "PullRequestChangedFile") {
 * fields { name } } }'`) : pas de `previousFilename`. Un renommage de
 * `tools.ts` vers un autre nom serait donc invisible au gate s'il ne lisait
 * que cette sortie-là. L'API REST (`repos/:owner/:repo/pulls/:n/files`), elle,
 * expose `previous_filename` pour un fichier renommé — c'est donc elle qu'on
 * appelle ici, pas `gh pr view`.
 *
 * `--paginate` fait qu'un `gh api` sur un endpoint qui rend un tableau JSON
 * imprime UNE page par appel HTTP (documenté par `gh api --help` : « Each
 * page is a separate JSON array or object »), donc plusieurs tableaux
 * concaténés sur stdout au-delà de la première page — `--slurp` les enveloppe
 * dans un tableau englobant unique, exploitable par un seul `JSON.parse`.
 */
export async function listPullRequestFiles(
  repoFullName: string,
  number: number,
): Promise<PullRequestFile[]> {
  const { stdout } = await run('gh', [
    'api',
    `repos/${repoFullName}/pulls/${number}/files`,
    '--paginate',
    '--slurp',
  ])
  const pages = JSON.parse(stdout) as Array<
    Array<{ filename: string; previous_filename?: string | null; status: string }>
  >
  return pages.flat().map((f) => ({
    path: f.filename,
    status: f.status,
    ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
  }))
}

/**
 * Liste les checks CI d'une PR. `gh pr checks` sort en erreur (code retour
 * non nul) dès qu'un check est en attente ou en échec — documenté par `gh`
 * lui-même (« Additional exit codes: 8: Checks pending ») — alors même que le
 * JSON demandé est bien présent sur stdout. On le lit donc depuis l'erreur
 * plutôt que de la laisser remonter telle quelle ; une PR sans aucun check
 * enregistré (ni CI configurée) rend une liste vide plutôt qu'une exception.
 */
export async function listChecks(repoFullName: string, number: number): Promise<CheckRun[]> {
  const args = [
    'pr',
    'checks',
    String(number),
    '--repo',
    repoFullName,
    '--json',
    'name,state,bucket,link',
  ]
  try {
    const { stdout } = await run('gh', args)
    return JSON.parse(stdout) as CheckRun[]
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout
    if (!stdout) return []
    try {
      return JSON.parse(stdout) as CheckRun[]
    } catch {
      return []
    }
  }
}

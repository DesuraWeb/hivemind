import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { type InboxItemRow, createInboxItem } from '../inbox/repo'
import {
  DEFAULT_GUARDED_PATHS,
  GUARDED_PATHS_SETTINGS_KEY,
  type GuardedPathEntry,
  isGuardedPathEntry,
} from './guarded-paths'

/** Sous-type distinctif de l'item levé par ce gate (`inbox_items.subtype` reste du texte libre, aucune contrainte DB). */
export const SELFMOD_INBOX_SUBTYPE = 'security_selfmod'

/**
 * Forme minimale nécessaire à la détection, indépendante de la source
 * (`gh api repos/:owner/:repo/pulls/:n/files`, ou un fixture de test).
 * `previousPath` n'existe que pour un fichier renommé — c'est justement ce
 * champ qui permet d'attraper un renommage AWAY d'un chemin surveillé
 * (`tools.ts` → `tools-v2.ts` resterait invisible en ne lisant que `path`).
 */
export interface ChangedFile {
  path: string
  previousPath?: string
  /** brut GitHub : added|removed|modified|renamed|copied|changed|unchanged. Non exploité pour le matching (path/previousPath suffisent), gardé pour le payload. */
  status?: string
}

export interface SelfmodMatch {
  entry: GuardedPathEntry
  file: ChangedFile
}

export interface RunSelfmodGateOptions {
  runId: string
  projectId: string
  prNumber: number
  prUrl: string
  files: ChangedFile[]
}

/**
 * Lit `settings['security.guarded_paths']` directement (pas de `SettingsStore`
 * / `SecretBox` : cette liste n'a rien de secret, c'est un réglage public comme
 * `hive.stack_rules`). Une valeur absente ou malformée retombe sur
 * `DEFAULT_GUARDED_PATHS` plutôt que de désarmer silencieusement le gate — la
 * même logique de repli que `inbox/optimize.ts` pour `hive.answer_baseline`.
 */
export async function loadGuardedPaths(db: Kysely<Database>): Promise<GuardedPathEntry[]> {
  const row = await db
    .selectFrom('settings')
    .select('value')
    .where('key', '=', GUARDED_PATHS_SETTINGS_KEY)
    .executeTakeFirst()

  const value = row?.value
  if (Array.isArray(value) && value.length > 0 && value.every(isGuardedPathEntry)) {
    return value
  }
  return DEFAULT_GUARDED_PATHS
}

/**
 * Comparaison exacte, jamais par inclusion : un chemin voisin (`tools.ts`
 * guardé, PR touchant `tools.test.ts` ou `runtime/tools/index.ts`) ne doit
 * JAMAIS matcher — un faux positif userait la confiance dans ce gate aussi
 * sûrement qu'un faux négatif. `previousPath` couvre le renommage, `path`
 * seul couvre déjà la suppression (GitHub rend `filename` = le chemin
 * supprimé, `status: 'removed'`).
 */
function matches(entry: GuardedPathEntry, file: ChangedFile): boolean {
  return file.path === entry.path || file.previousPath === entry.path
}

function findMatches(files: ChangedFile[], guarded: GuardedPathEntry[]): SelfmodMatch[] {
  const found: SelfmodMatch[] = []
  for (const file of files) {
    for (const entry of guarded) {
      if (matches(entry, file)) found.push({ entry, file })
    }
  }
  return found
}

function fileLabel(file: ChangedFile): string {
  if (file.previousPath && file.previousPath !== file.path) {
    return `${file.path} (renommé depuis ${file.previousPath})`
  }
  return file.path
}

function buildTitle(prNumber: number, found: SelfmodMatch[]): string {
  // Le nom du chemin GARDÉ (`entry.path`), pas celui du fichier après un
  // renommage : un renommage away de `run-state.ts` doit se lire « run-
  // state.ts » dans le titre, pas le nouveau nom qui ne dit rien à un humain
  // qui cherche à reconnaître d'un coup d'œil ce qui est protégé.
  const names = found.map((m) => m.entry.path.split('/').pop()).join(', ')
  return `PR #${prNumber} modifie la frontière de sécurité : ${names}`
}

function buildCtx(found: SelfmodMatch[]): string {
  const lines = found.map((m) => `- ${fileLabel(m.file)} — ${m.entry.reason}`)
  return [
    "Distinct d'une validation de step ordinaire (approval:step_end) : ces fichiers ne sont pas le résultat d'un step, ce sont les gates de sécurité eux-mêmes (machine à états, politique d'outils, droits d'un rôle).",
    "Ceci ne bloque pas le run : il continue son cours normalement. Cet item existe pour qu'un humain relise le diff avant la fusion de la PR.",
    '',
    'Fichiers concernés :',
    ...lines,
  ].join('\n')
}

/**
 * Le 4ᵉ gate. Compare les fichiers modifiés d'une PR à `security.guarded_paths`
 * et, en cas de correspondance, lève un item d'inbox `alert` distinct — via
 * `createInboxItem` (inbox/repo.ts), le chemin d'entrée direct prévu pour « les
 * items qui ne naissent pas d'un Effect de la machine à états » : ce gate
 * n'ajoute donc ni événement ni effet à `domain/run-state.ts`, qui reste l'un
 * des trois fichiers que ce gate protège. `pr_opened` continue de traverser
 * `decide()` normalement, sans savoir que ce gate existe — l'item est bien
 * levé EN PARALLÈLE du flux ordinaire, pas à sa place.
 *
 * Dédoublonné comme `health/auth-check.ts` : tant qu'un item ouvert du même
 * sous-type existe déjà pour ce run, un nouvel appel (PR mise à jour après un
 * `review_ko`, par exemple) n'en recrée pas un second.
 */
export async function runSelfmodGate(
  db: Kysely<Database>,
  opts: RunSelfmodGateOptions,
): Promise<InboxItemRow | undefined> {
  const guarded = await loadGuardedPaths(db)
  const found = findMatches(opts.files, guarded)
  if (found.length === 0) return undefined

  const existing = await db
    .selectFrom('inbox_items')
    .select('id')
    .where('run_id', '=', opts.runId)
    .where('type', '=', 'alert')
    .where('subtype', '=', SELFMOD_INBOX_SUBTYPE)
    .where('status', '=', 'open')
    .executeTakeFirst()
  if (existing) return undefined

  return createInboxItem(db, {
    type: 'alert',
    subtype: SELFMOD_INBOX_SUBTYPE,
    projectId: opts.projectId,
    runId: opts.runId,
    fromRole: 'system',
    title: buildTitle(opts.prNumber, found),
    payload: {
      cause: buildTitle(opts.prNumber, found),
      ctx: buildCtx(found),
      pr_number: opts.prNumber,
      pr_url: opts.prUrl,
      matched_paths: found.map((m) => ({
        path: m.file.path,
        previous_path: m.file.previousPath ?? null,
        status: m.file.status ?? null,
        reason: m.entry.reason,
      })),
    },
  })
}

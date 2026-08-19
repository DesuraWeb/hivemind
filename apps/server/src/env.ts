import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { z } from 'zod'

/**
 * Remonte depuis `from` jusqu'au répertoire contenant `pnpm-workspace.yaml`.
 *
 * Le `.env` vit à la racine du monorepo, mais le cwd dépend de l'invocation :
 * `pnpm db:migrate` délègue via `pnpm --filter`, ce qui place le cwd dans
 * `apps/server`. Résoudre par rapport au cwd rendrait le chargement dépendant
 * de l'endroit d'où on lance la commande.
 */
function findRepoRoot(from = process.cwd()): string | undefined {
  let dir = from
  const { root } = parse(dir)
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    if (dir === root) return undefined
    dir = dirname(dir)
  }
}

/**
 * Résout un chemin de configuration relatif à la RACINE DU DÉPÔT, jamais au
 * cwd. Même raison que pour `.env` ci-dessus : `pnpm --filter` place le cwd
 * dans `apps/server`, et `./apps/web/dist` n'y existe pas. Mesuré en démarrant
 * réellement en production — le front rendait 503 sur toutes les pages.
 *
 * Un chemin déjà absolu est rendu tel quel : en production on peut vouloir
 * pointer ailleurs que dans le dépôt.
 */
/**
 * Destinataire des alertes système quand `ALERT_EMAIL_TO` n'est pas renseigné.
 *
 * Une adresse générique et non celle de l'exploitant : ce dépôt est destiné à
 * être public, et y coder en dur l'adresse de quelqu'un enverrait ses alertes
 * à un inconnu chez qui l'installation tournerait. Le repli sert à ce que le
 * démarrage n'échoue pas, pas à joindre réellement quelqu'un — renseignez
 * `ALERT_EMAIL_TO`.
 */
export const DEFAULT_ALERT_EMAIL = 'alerts@localhost'

export function fromRepoRoot(relatif: string): string {
  if (isAbsolute(relatif)) return relatif
  const racine = findRepoRoot()
  return racine ? resolve(racine, relatif) : resolve(relatif)
}

/**
 * Charge `.env` dans process.env si le fichier existe, sans jamais écraser une
 * variable déjà définie — l'environnement réel (CI, prod) garde la main.
 * Fait ici plutôt que via un flag de lancement : dev, prod et tests passent
 * tous par `loadEnv()`, donc un seul endroit à connaître.
 */
function loadDotEnvFile(path?: string): void {
  const root = findRepoRoot()
  const resolved = path ?? (root ? join(root, '.env') : '.env')
  let raw: string
  try {
    raw = readFileSync(resolved, 'utf8')
  } catch {
    return // absent : normal en CI, tout vient de l'environnement du job
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (process.env[key] !== undefined) continue
    process.env[key] = trimmed.slice(eq + 1).trim()
  }
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Racine du front construit, servie par le serveur en production seulement.
   * En développement Vite sert le front sur son propre port : ce réglage est
   * ignoré. Relatif à la racine du dépôt.
   */
  WEB_DIST: z.string().default('./apps/web/dist'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: z.string().optional(),
  MASTER_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(1),
  RUNTIME_ADAPTER: z.enum(['claude', 'fake']).default('claude'),
  WORKTREES_ROOT: z.string().default('./worktrees'),
  ARTIFACTS_ROOT: z.string().default('./artifacts'),
  MAIL_DRY_RUN: z.coerce.number().default(1),
  PROD_DISPATCH_DRY_RUN: z.coerce.number().default(1),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  ALERT_EMAIL_TO: z.string().optional(),
  ALERT_EMAIL_FROM: z.string().optional(),
})

export type Env = z.infer<typeof schema>

export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  if (!source) loadDotEnvFile()
  const parsed = schema.safeParse(source ?? process.env)
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Configuration invalide :\n${details}`)
  }
  return parsed.data
}

/** URL de connexion effective : la base de test quand NODE_ENV=test. */
export function databaseUrl(env: Env): string {
  if (env.NODE_ENV === 'test') {
    if (!env.DATABASE_URL_TEST) throw new Error('DATABASE_URL_TEST manquant en NODE_ENV=test')
    return env.DATABASE_URL_TEST
  }
  return env.DATABASE_URL
}

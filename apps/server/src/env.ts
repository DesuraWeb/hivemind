import { readFileSync } from 'node:fs'
import { z } from 'zod'

/**
 * Charge `.env` dans process.env si le fichier existe, sans jamais écraser une
 * variable déjà définie — l'environnement réel (CI, prod) garde la main.
 * Fait ici plutôt que via un flag de lancement : dev, prod et tests passent
 * tous par `loadEnv()`, donc un seul endroit à connaître.
 */
function loadDotEnvFile(path = '.env'): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
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

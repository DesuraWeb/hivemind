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
function loadDotEnvFile(path?: string): string | null {
  const root = findRepoRoot()
  const resolved = path ?? (root ? join(root, '.env') : '.env')
  let raw: string
  try {
    raw = readFileSync(resolved, 'utf8')
  } catch {
    return null // absent : normal en CI, tout vient de l'environnement du job
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
  return resolved
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
  /**
   * Interface d'écoute. **`127.0.0.1` par défaut, et c'est délibéré.**
   *
   * Le serveur écoutait sur `0.0.0.0`. Sur une machine nue derrière un reverse
   * proxy, ça veut dire que l'application est joignable en clair depuis
   * l'extérieur en contournant nginx, son TLS et son authentification — il
   * suffit d'appeler le port applicatif directement.
   *
   * Constaté sur le VPS de l'agence au moment de la mise en service : `ufw`
   * inactif, `iptables` en politique `ACCEPT` sans une seule règle. Le
   * pare-feu a été posé, mais un pare-feu est une SECONDE barrière — il ne
   * remplace pas le fait de ne pas s'exposer. Le défaut doit protéger une
   * installation dont personne n'a encore réglé le réseau.
   *
   * Un déploiement en conteneur a besoin de `0.0.0.0` pour être joignable
   * depuis l'hôte : il pose `HOST=0.0.0.0` explicitement, en sachant ce qu'il
   * fait. C'est le bon sens de la contrainte — l'exposition se demande, elle
   * ne s'hérite pas.
   */
  HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: z.string().optional(),
  MASTER_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(1),
  RUNTIME_ADAPTER: z.enum(['claude', 'fake']).default('claude'),
  WORKTREES_ROOT: z.string().default('./worktrees'),
  /**
   * Combien de boucles peuvent avancer EN MÊME TEMPS sur cette machine.
   *
   * Jusqu'ici : une seule, et jamais par décision — c'était le défaut de
   * pg-boss (`localConcurrency: 1`), personne ne l'avait choisi. Une file
   * d'attente d'un projet derrière l'autre, sur une machine qui ne travaille
   * qu'à quelques pourcents.
   *
   * Trois, mesuré et pas deviné. Sur le serveur de Florian : 8,3 Go de RAM
   * libre, un agent en vaut ~285 Mo (Node + Chromium quand le juge capture),
   * et surtout AUCUN swap. Sans swap, dépasser la RAM ne ralentit pas la
   * machine, l'OOM killer tue un process au hasard — un run à moitié fait, un
   * worktree resté en place. Trois laisse une marge que la mesure justifie ;
   * au-delà, il faut d'abord ajouter du swap.
   *
   * Par machine, donc par variable d'environnement et pas par réglage en base :
   * le portable de développement et le VPS n'ont pas la même RAM, et un
   * réglage partagé leur imposerait le même chiffre.
   */
  LOOP_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
  ARTIFACTS_ROOT: z.string().default('./artifacts'),
  /**
   * Chromium fourni par le système, au lieu de celui que Playwright télécharge.
   *
   * Playwright 1.62 récupère `chromium` et `chromium-headless-shell` depuis le
   * bucket « Chrome for Testing » de Google. Ce bucket **refuse certaines
   * adresses IP selon leur localisation** : sur le VPS de l'agence, il répond
   * `403 AccessDenied · this service is not available in your location`.
   * Diagnostiqué en isolant les artefacts — `ffmpeg`, servi par l'ancien
   * chemin, se télécharge sans problème depuis la même machine, et une
   * révision de Chromium antérieure au passage à CFT aussi. Ce n'est donc ni
   * le réseau, ni les droits, ni `PLAYWRIGHT_BROWSERS_PATH`.
   *
   * Trois sorties étaient possibles. Épingler une version antérieure ferait
   * dépendre le projet d'un détail d'hébergement de Google. Un miroir maison
   * demanderait un endroit où l'héberger, à maintenir. Reste celle-ci, la
   * seule qui traite le problème général : **ce produit est auto-hébergé, et
   * quiconque l'installe derrière un réseau restreint rencontrera ce mur.**
   *
   * Absente, rien ne change : Playwright utilise son navigateur habituel.
   * Renseignée, elle pointe un binaire déjà présent (`chromium`,
   * `chromium-browser`, Chrome…). Le juge capture alors avec CE navigateur,
   * qui n'est pas la version que Playwright embarque — un écart de rendu
   * reste possible, et vaut mieux qu'un juge qui ne démarre pas.
   */
  CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
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
  const fichier = source ? undefined : loadDotEnvFile()
  const parsed = schema.safeParse(source ?? process.env)
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    // DIRE OÙ ON A CHERCHÉ. Sans ça, un script lancé hors du dépôt échoue sur
    // « Configuration invalide » sans le moindre indice : `findRepoRoot`
    // remonte depuis le RÉPERTOIRE COURANT, donc le `.env` n'est pas trouvé et
    // la cause a l'air d'être la configuration elle-même. Signalé après s'être
    // fait avoir une fois, à la mise en service du VPS.
    const ou = source
      ? '  (source explicite, aucun .env lu)'
      : fichier
        ? `  .env lu : ${fichier}`
        : `  aucun .env trouvé depuis ${process.cwd()} · la racine est le dossier qui contient pnpm-workspace.yaml, lance la commande depuis là ou passe les variables dans l'environnement`
    throw new Error(`Configuration invalide :\n${details}\n${ou}`)
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

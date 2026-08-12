# silithid — Phase 1 (J1–J2) : Fondations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poser le socle exécutable du projet — monorepo pnpm typé, base PostgreSQL migrée et seedée, chiffrement des secrets, authentification mono-utilisateur, et l'interface `RuntimeAdapter` avec une implémentation Claude capable de faire répondre un agent dans un worktree git jetable.

**Architecture:** Un seul process Node (Fastify) sert l'API HTTP et, à partir de la Phase 2, les workers pg-boss. Le domaine métier est en TypeScript pur (`src/domain`), l'accès DB passe par Kysely sur des migrations SQL brutes versionnées, et tout appel à un modèle passe par l'interface `RuntimeAdapter` (une seule implémentation en v0 : `ClaudeAdapter` sur `@anthropic-ai/claude-agent-sdk`) afin que le reste du code n'en dépende jamais directement.

**Tech Stack:** Node 22 LTS · TypeScript strict (ESM, exécution via `tsx`) · pnpm workspaces · Fastify 5 · PostgreSQL 16 (Homebrew, local) · Kysely + `pg` · libsodium-wrappers · `@node-rs/argon2` · nodemailer · Vitest · Biome · React 18 + Vite

---

## Prérequis machine (à faire une fois, avant la Task 1)

Vérifié sur cette machine le 2026-08-11 :

| Outil | État | Action |
|---|---|---|
| Node 22.22.3 | ✅ installé | — |
| PostgreSQL 16 (Homebrew) | ✅ installé | `brew services start postgresql@16` |
| git 2.50 | ✅ installé | — |
| `corepack` | ✅ installé | `corepack enable pnpm` |
| `pnpm` | ❌ absent | fourni par corepack ci-dessus |
| runtime conteneur | ❌ absent | **non requis** — pas de Docker dans cette phase |
| CLI `claude` authentifiée | à vérifier | `claude --version` puis une session interactive pour valider le login |

```bash
corepack enable pnpm && brew services start postgresql@16 && psql -l
```

**Décision actée :** pas de Docker pendant le sprint. La DoD §14 « `docker compose up` reproductible sur VPS vierge » est remplacée par « setup reproductible scripté » (`scripts/setup.sh` + `.env.example` + doc d'exploitation). Le choix de packaging VPS se fait à J15.

---

## Décisions verrouillées pour cette phase

Ces points ne sont pas à re-débattre pendant l'exécution ; ils sont choisis pour minimiser le nombre de pièces mobiles.

1. **Pas d'étape de build côté serveur.** Le serveur tourne sous `tsx` en dev *et* en prod. Conséquence : `moduleResolution: "bundler"`, imports relatifs sans extension `.js`. Le typage est vérifié séparément par `tsc --noEmit`. Coût : ~200 ms de démarrage en plus. Gain : zéro configuration de bundler, zéro décalage `src`/`dist`.
2. **Biome** remplace ESLint + Prettier (un seul binaire, un seul fichier de config, `biome check` en CI).
3. **Session par cookie signé**, pas de store serveur. `@fastify/cookie` avec `signed: true` (HMAC pur JS, aucune dépendance native). Mono-utilisateur : un store serveur n'apporterait rien.
4. **`@node-rs/argon2`** et non `argon2` : prebuilds napi pour `darwin-arm64` et Linux, pas de node-gyp.
5. **Migrations SQL brutes** avec un runner maison de ~60 lignes (le brief exclut un ORM lourd ; l'API de migration de Kysely imposerait des migrations en TS).
6. **Le `RuntimeAdapter` est écrit avant le `ClaudeAdapter`**, et un `FakeAdapter` déterministe existe dès la Task 9 pour que les phases suivantes soient testables sans consommer de tokens.

### Écarts assumés par rapport au brief §5 (schéma SQL)

Trois corrections, toutes signalées ici pour qu'elles ne passent pas pour des erreurs de transcription :

- `projects.context md text` du brief est invalide (deux types) → la colonne s'appelle `context` et son type est le domaine `md`.
- **Ajout d'une table `users`** : le brief prévoit « login + mot de passe hashé argon2 » (§3) mais aucune table pour le stocker. Mettre un hash argon2 dans `settings` mélangerait secret et configuration.
- **Ajout de `inbox_items.created_at`** : `blocked_since` sert la métrique « depuis combien de temps ça bloque », ce qui n'est pas la même chose que la date de création pour les items non bloquants (`info`, `verdict`).

### Écart assumé sur `RuntimeAdapter.usage()`

Le brief spécifie `usage(): Promise<{ fiveHourPct, sevenDayPct }>`. Il n'est **pas établi** que le SDK expose ces fenêtres. La Task 10 commence par une vérification des types installés. Si l'information n'est pas disponible, la signature devient `Promise<{ fiveHourPct: number; sevenDayPct: number; available: boolean }>` et l'implémentation retourne `available: false` — le scheduler de budget (J12) ne se met alors jamais en pause plutôt que de se baser sur des chiffres inventés. **Ne pas fabriquer de valeurs plausibles.**

---

## Structure de fichiers

Chaque fichier a une responsabilité unique. Les fichiers qui changent ensemble vivent ensemble.

```
silithid/
├── package.json                        # workspace root, scripts, engines
├── pnpm-workspace.yaml
├── tsconfig.base.json                  # options strictes partagées
├── biome.json
├── vitest.config.ts                    # projects: server
├── .env.example                        # toutes les variables, valeurs factices
├── .gitignore
├── scripts/
│   ├── setup.sh                        # bootstrap machine vierge
│   └── db-reset.sh                     # drop + create + migrate + seed
├── .github/workflows/ci.yml            # lint + typecheck + test
├── docs/superpowers/plans/             # ce document
├── packages/shared/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                    # re-exports
│       ├── roles.ts                    # ROLE_KEYS, type RoleKey
│       ├── run.ts                      # RUN_STATES, type RunState
│       └── inbox.ts                    # INBOX_TYPES, type InboxType
└── apps/
    ├── server/
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts                # bootstrap : env → db → app → listen
    │       ├── app.ts                  # construction Fastify (testable sans listen)
    │       ├── env.ts                  # parsing zod de process.env
    │       ├── db/
    │       │   ├── client.ts           # Pool pg + instance Kysely
    │       │   ├── types.ts            # interface Database (Kysely)
    │       │   ├── migrate.ts          # runner de migrations
    │       │   ├── migrations/0001_init.sql
    │       │   ├── seed.ts             # seed des role_templates
    │       │   └── seeds/role_templates/{majordome,garant,dev,reviewer,judge,communicant}.md
    │       ├── crypto/secrets.ts       # encryptJson / decryptJson (libsodium)
    │       ├── auth/
    │       │   ├── password.ts         # hash / verify argon2
    │       │   ├── session.ts          # plugin cookie + decorator requireAuth
    │       │   └── users.ts            # repo users
    │       ├── settings/store.ts       # get/set settings, secrets chiffrés
    │       ├── integrations/mailer.ts  # nodemailer + MAIL_DRY_RUN
    │       ├── runtime/
    │       │   ├── types.ts            # RuntimeAdapter, AgentSession, AgentEvent…
    │       │   ├── fake.ts             # FakeAdapter déterministe
    │       │   ├── claude.ts           # ClaudeAdapter (Agent SDK)
    │       │   └── index.ts            # factory selon RUNTIME_ADAPTER
    │       ├── health/auth-check.ts    # healthcheck du token agent
    │       └── api/routes/
    │           ├── health.ts
    │           ├── auth.ts
    │           └── settings.ts
    └── web/
        ├── package.json
        ├── tsconfig.json
        ├── vite.config.ts
        ├── index.html
        └── src/
            ├── main.tsx
            ├── App.tsx
            ├── lib/api.ts
            ├── styles/tokens.css       # tokens DA (placeholders explicites)
            └── routes/Login.tsx
```

---

## Task 1 : Squelette du monorepo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.env.example`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`

- [ ] **Step 1 : initialiser le dépôt git**

Le répertoire n'est pas encore un dépôt git.

```bash
cd /Users/desura/Github/silithid && git init -b main
```

- [ ] **Step 2 : écrire les fichiers racine**

`package.json` :

```json
{
  "name": "silithid",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "pnpm --filter @silithid/server dev",
    "dev:web": "pnpm --filter @silithid/web dev",
    "typecheck": "tsc --noEmit -p apps/server && tsc --noEmit -p packages/shared",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "test": "vitest run",
    "db:migrate": "pnpm --filter @silithid/server db:migrate",
    "db:seed": "pnpm --filter @silithid/server db:seed",
    "db:reset": "./scripts/db-reset.sh"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`pnpm-workspace.yaml` :

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json` :

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  }
}
```

`biome.json` :

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "files": { "ignore": ["**/dist/**", "**/node_modules/**", "**/*.sql"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "useImportType": "error" },
      "suspicious": { "noExplicitAny": "error" }
    }
  },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "asNeeded" } }
}
```

`.gitignore` :

```
node_modules/
dist/
.env
.env.local
*.log
.DS_Store
/worktrees/
/artifacts/
coverage/
```

`.env.example` :

```
# --- Base de données ---
DATABASE_URL=postgres://desura@localhost:5432/silithid
DATABASE_URL_TEST=postgres://desura@localhost:5432/silithid_test

# --- Serveur ---
PORT=3000
NODE_ENV=development

# --- Secrets (générer avec: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") ---
MASTER_KEY=REMPLACER_32_OCTETS_BASE64
SESSION_SECRET=REMPLACER_32_OCTETS_BASE64

# --- Agents (RUNTIME_ADAPTER : claude | fake) ---
RUNTIME_ADAPTER=claude
WORKTREES_ROOT=./worktrees
ARTIFACTS_ROOT=./artifacts

# --- Mode dev : rien ne part vers l'extérieur ---
MAIL_DRY_RUN=1
PROD_DISPATCH_DRY_RUN=1

# --- SMTP (alertes critiques uniquement) ---
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
ALERT_EMAIL_TO=alerts@exemple.test
ALERT_EMAIL_FROM=silithid@desura.fr
```

- [ ] **Step 3 : écrire les manifestes des workspaces**

`packages/shared/package.json` :

```json
{
  "name": "@silithid/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/shared/tsconfig.json` :

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/shared/src/index.ts` :

```ts
export const SILITHID_VERSION = '0.0.0'
```

`apps/server/package.json` :

```json
{
  "name": "@silithid/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "db:migrate": "tsx src/db/migrate.ts",
    "db:seed": "tsx src/db/seed.ts"
  },
  "dependencies": {
    "@silithid/shared": "workspace:*",
    "fastify": "^5.2.0",
    "@fastify/cookie": "^11.0.1",
    "kysely": "^0.27.5",
    "pg": "^8.13.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.2"
  }
}
```

`apps/server/tsconfig.json` :

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "tests"]
}
```

- [ ] **Step 4 : installer et vérifier**

```bash
cd /Users/desura/Github/silithid && corepack enable pnpm && pnpm install && pnpm lint && pnpm typecheck
```

Attendu : `pnpm install` réussit, `biome check` ne signale rien, `tsc --noEmit` ne signale rien.

- [ ] **Step 5 : commit**

```bash
git add -A && git commit -m "chore: squelette monorepo pnpm + typescript strict + biome"
```

---

## Task 2 : Scripts de setup et bootstrap DB locale

**Files:**
- Create: `scripts/setup.sh`, `scripts/db-reset.sh`

- [ ] **Step 1 : écrire `scripts/setup.sh`**

```bash
#!/usr/bin/env bash
# Bootstrap d'une machine vierge (macOS). Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "Node 22+ requis (brew install node@22)"; exit 1; }
command -v psql >/dev/null || { echo "PostgreSQL 16 requis (brew install postgresql@16)"; exit 1; }

corepack enable pnpm
pnpm install

if [ ! -f .env ]; then
  cp .env.example .env
  # Génère des clés réelles pour que le premier démarrage fonctionne.
  MASTER=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  SESSION=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  # BSD sed (macOS) exige un argument après -i.
  sed -i '' "s|^MASTER_KEY=.*|MASTER_KEY=${MASTER}|" .env
  sed -i '' "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION}|" .env
  echo "→ .env créé avec des clés fraîches."
fi

createdb silithid 2>/dev/null || echo "→ base 'silithid' déjà présente"
createdb silithid_test 2>/dev/null || echo "→ base 'silithid_test' déjà présente"

pnpm db:migrate
pnpm db:seed
echo "✅ Setup terminé. Lancer: pnpm dev"
```

- [ ] **Step 2 : écrire `scripts/db-reset.sh`**

```bash
#!/usr/bin/env bash
# Repart d'une base vierge. Destructif — dev uniquement.
set -euo pipefail
cd "$(dirname "$0")/.."

read -rp "Supprimer et recréer la base 'silithid' ? [y/N] " ok
[ "$ok" = "y" ] || { echo "annulé"; exit 1; }

dropdb --if-exists silithid
createdb silithid
pnpm db:migrate
pnpm db:seed
echo "✅ Base réinitialisée."
```

- [ ] **Step 3 : rendre exécutables et créer les bases**

```bash
chmod +x scripts/*.sh && createdb silithid && createdb silithid_test && psql -l | grep silithid
```

Attendu : les deux bases `silithid` et `silithid_test` apparaissent.

- [ ] **Step 4 : commit**

```bash
git add -A && git commit -m "chore: scripts de setup et de reset de la base locale"
```

---

## Task 3 : Runner de migrations SQL (TDD)

**Files:**
- Create: `apps/server/src/env.ts`
- Create: `apps/server/src/db/client.ts`
- Create: `apps/server/src/db/migrate.ts`
- Test: `apps/server/tests/migrate.test.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1 : écrire `env.ts` et `db/client.ts` (pré-requis non testés directement)**

`apps/server/src/env.ts` :

```ts
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
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
```

`apps/server/src/db/client.ts` :

```ts
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { databaseUrl, loadEnv } from '../env'
import type { Database } from './types'

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 })
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}

let singleton: { pool: pg.Pool; db: Kysely<Database> } | undefined

export function getDb(): Kysely<Database> {
  if (!singleton) {
    const pool = createPool(databaseUrl(loadEnv()))
    singleton = { pool, db: createDb(pool) }
  }
  return singleton.db
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.db.destroy()
    singleton = undefined
  }
}
```

`apps/server/src/db/types.ts` — stub minimal pour l'instant, complété en Task 4 :

```ts
// biome-ignore lint/complexity/noBannedTypes: complété par la Task 4
export type Database = {}
```

- [ ] **Step 2 : écrire `vitest.config.ts` à la racine**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/server/tests/**/*.test.ts'],
    // `.env` est chargé par loadEnv() lui-même ; on ne force ici que ce qui
    // doit différer en test.
    env: {
      NODE_ENV: 'test',
      // Aucun test n'appelle un vrai modèle : la suite ne consomme pas de tokens.
      RUNTIME_ADAPTER: 'fake',
    },
    fileParallelism: false, // les tests partagent une base Postgres
    hookTimeout: 30_000,
  },
})
```

Un test rapide de `loadDotEnvFile` mérite d'exister — ajouter à `apps/server/tests/env.test.ts` :

```ts
import { expect, test } from 'vitest'
import { databaseUrl, loadEnv } from '../src/env'

test('loadEnv lit .env et fournit les clés requises', () => {
  const env = loadEnv()
  expect(env.MASTER_KEY.length).toBeGreaterThan(0)
  expect(env.SESSION_SECRET.length).toBeGreaterThan(0)
})

test('databaseUrl bascule sur la base de test en NODE_ENV=test', () => {
  const env = loadEnv()
  expect(env.NODE_ENV).toBe('test')
  expect(databaseUrl(env)).toContain('silithid_test')
})

test('une source explicite court-circuite .env et rejette une config invalide', () => {
  expect(() => loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/)
})
```

> **Deux pièges que ce dispositif évite**, découverts en exécutant la Task 2 :
> — `vitest` ne charge pas `.env`, mais **`tsx` non plus** : sans chargement dans `loadEnv()`, `pnpm dev` planterait sur `MASTER_KEY` manquant à la Task 7.
> — Le parser ne retire **pas** les commentaires en fin de ligne, pour ne pas corrompre un secret contenant `#`. C'est pourquoi `.env.example` ne doit contenir que des commentaires en ligne entière.

- [ ] **Step 3 : écrire le test qui échoue**

`apps/server/tests/migrate.test.ts` :

```ts
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts).
// Passer par databaseUrl() plutôt qu'une URL en dur : sinon un changement de
// configuration ferait tourner les tests contre une autre base sans le dire.
const pool = createPool(databaseUrl(loadEnv()))
const db = createDb(pool)

beforeAll(async () => {
  // Repart d'un schéma vierge à chaque exécution de la suite.
  await sql`drop schema public cascade; create schema public;`.execute(db)
})

afterAll(async () => {
  await db.destroy()
})

test('applique les migrations et enregistre leur nom', async () => {
  const applied = await runMigrations(db)
  expect(applied).toContain('0001_init.sql')

  const rows = await sql<{ name: string }>`select name from schema_migrations`.execute(db)
  expect(rows.rows.map((r) => r.name)).toContain('0001_init.sql')
})

test('est idempotent : un second passage n applique rien', async () => {
  const applied = await runMigrations(db)
  expect(applied).toEqual([])
})
```

- [ ] **Step 4 : lancer le test et vérifier qu'il échoue**

```bash
pnpm test
```

Attendu : ÉCHEC avec `Failed to resolve import "../src/db/migrate"`.

- [ ] **Step 5 : implémenter le runner**

`apps/server/src/db/migrate.ts` :

```ts
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Kysely, sql } from 'kysely'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

/**
 * Applique les migrations `.sql` non encore jouées, par ordre alphabétique.
 * Chaque migration s'exécute dans sa propre transaction : une migration qui
 * échoue laisse les précédentes en place et n'est pas marquée comme appliquée.
 * Un verrou consultatif empêche deux process de migrer en même temps.
 */
export async function runMigrations<DB>(db: Kysely<DB>): Promise<string[]> {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `.execute(db)

  // 4242 : identifiant arbitraire mais stable du verrou de migration.
  await sql`select pg_advisory_lock(4242)`.execute(db)
  try {
    const done = new Set(
      (await sql<{ name: string }>`select name from schema_migrations`.execute(db)).rows.map(
        (r) => r.name,
      ),
    )

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

    const applied: string[] = []
    for (const file of files) {
      if (done.has(file)) continue
      const content = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      await db.transaction().execute(async (trx) => {
        await sql.raw(content).execute(trx)
        await sql`insert into schema_migrations (name) values (${file})`.execute(trx)
      })
      applied.push(file)
    }
    return applied
  } finally {
    await sql`select pg_advisory_unlock(4242)`.execute(db)
  }
}

// Point d'entrée CLI : `pnpm db:migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb, closeDb } = await import('./client')
  const applied = await runMigrations(getDb())
  console.log(applied.length ? `Appliquées : ${applied.join(', ')}` : 'Aucune migration à appliquer')
  await closeDb()
}
```

- [ ] **Step 6 : créer la migration initiale**

`apps/server/src/db/migrations/0001_init.sql` :

```sql
-- Domaine sémantique : du texte destiné à contenir du markdown.
create domain md as text;

-- Utilisateur unique de l'outil (mono-user en v0).
create table users (
  id uuid primary key default gen_random_uuid(),
  login text unique not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  siret text,
  contacts jsonb not null default '[]',
  tone text,
  notes jsonb not null default '[]',      -- {q, a, source_item_id, at}
  secrets jsonb not null default '{}',    -- chiffré applicativement (libsodium)
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id),
  name text not null,
  slug text unique not null,
  repo_full_name text not null,           -- ex: desura/lekoin
  default_branch text not null default 'main',
  staging_url text,
  context md,                             -- contexte produit injecté aux agents
  autonomy_default text not null default 'gated'
    check (autonomy_default in ('gated','auto')),
  budget_weight int not null default 5
    check (budget_weight between 1 and 10),
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table steps (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  position int not null,
  title text not null,
  specs md not null,
  autonomy text check (autonomy in ('gated','auto')),  -- null = hérite du projet
  max_iterations int not null default 4,
  budget_tokens int,
  status text not null default 'pending'
    check (status in ('pending','running','awaiting_human','validated','failed')),
  created_at timestamptz not null default now()
);
create index steps_project_position_idx on steps (project_id, position);

create table role_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null,                      -- majordome|garant|dev|reviewer|judge|communicant
  project_type text not null default 'generic',
  version int not null default 1,
  system_prompt md not null,
  tools jsonb not null,
  model text,
  unique (key, project_type, version)
);

-- Instance par projet : copie éditable d'un template.
create table roles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  template_id uuid references role_templates(id),
  key text not null,
  system_prompt md not null,
  tools jsonb not null,
  model text,
  enabled bool not null default true,
  unique (project_id, key)
);

-- Une boucle.
create table runs (
  id uuid primary key default gen_random_uuid(),
  step_id uuid not null references steps(id) on delete cascade,
  iteration int not null default 1,
  state text not null default 'framing' check (state in
    ('framing','coding','design_wait','reviewing','deploying','judging','verdict',
     'awaiting_human','done','failed','paused_budget')),
  branch text,
  pr_number int,
  worktree_path text,
  cost_tokens bigint not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index runs_step_idx on runs (step_id);
create index runs_state_idx on runs (state);

create table agent_sessions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete cascade,
  role_key text not null,
  sdk_session_id text,
  state text not null default 'idle',
  cost_tokens bigint not null default 0,
  created_at timestamptz not null default now()
);
create index agent_sessions_run_idx on agent_sessions (run_id);

-- Bus inter-agents : persisté = piste d'audit.
create table messages (
  id bigint generated always as identity primary key,
  run_id uuid references runs(id) on delete cascade,
  from_role text not null,
  to_role text not null,
  kind text not null,                     -- prompt|report|question|correction|info
  body md not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index messages_run_created_idx on messages (run_id, created_at);

create table inbox_items (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('question','approval','handoff','verdict','alert','info')),
  subtype text,                           -- approval: email|prod|step_end
  project_id uuid references projects(id) on delete cascade,
  run_id uuid references runs(id) on delete cascade,
  title text not null,
  payload jsonb not null,
  status text not null default 'open' check (status in ('open','done','dismissed')),
  human_response jsonb,
  created_at timestamptz not null default now(),
  blocked_since timestamptz not null default now(),
  resolved_at timestamptz,
  archive_to_client bool not null default true
);
create index inbox_items_open_idx on inbox_items (status, created_at desc);

-- Suivi de consommation du compte Claude.
create table usage_windows (
  id bigint generated always as identity primary key,
  window_kind text not null check (window_kind in ('5h','7d')),
  used_pct numeric,
  raw jsonb,
  sampled_at timestamptz not null default now()
);
create index usage_windows_sampled_idx on usage_windows (sampled_at desc);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete cascade,
  kind text not null,                     -- screenshot|judge_report|diff
  path text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index artifacts_run_idx on artifacts (run_id);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
```

- [ ] **Step 7 : relancer le test**

```bash
pnpm test
```

Attendu : les deux tests passent.

- [ ] **Step 8 : commit**

```bash
git add -A && git commit -m "feat(db): runner de migrations SQL + schéma initial"
```

---

## Task 4 : Types Kysely de la base

**Files:**
- Modify: `apps/server/src/db/types.ts` (remplace le stub)
- Create: `packages/shared/src/roles.ts`, `packages/shared/src/run.ts`, `packages/shared/src/inbox.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `apps/server/tests/db-types.test.ts`

- [ ] **Step 1 : écrire les unions partagées**

`packages/shared/src/roles.ts` :

```ts
export const ROLE_KEYS = ['majordome', 'garant', 'dev', 'reviewer', 'judge', 'communicant'] as const
export type RoleKey = (typeof ROLE_KEYS)[number]
```

`packages/shared/src/run.ts` :

```ts
export const RUN_STATES = [
  'framing',
  'coding',
  'design_wait',
  'reviewing',
  'deploying',
  'judging',
  'verdict',
  'awaiting_human',
  'done',
  'failed',
  'paused_budget',
] as const
export type RunState = (typeof RUN_STATES)[number]

export const AUTONOMY_MODES = ['gated', 'auto'] as const
export type AutonomyMode = (typeof AUTONOMY_MODES)[number]
```

`packages/shared/src/inbox.ts` :

```ts
export const INBOX_TYPES = ['question', 'approval', 'handoff', 'verdict', 'alert', 'info'] as const
export type InboxType = (typeof INBOX_TYPES)[number]

export const APPROVAL_SUBTYPES = ['email', 'prod', 'step_end'] as const
export type ApprovalSubtype = (typeof APPROVAL_SUBTYPES)[number]

export const INBOX_STATUSES = ['open', 'done', 'dismissed'] as const
export type InboxStatus = (typeof INBOX_STATUSES)[number]
```

`packages/shared/src/index.ts` :

```ts
export * from './inbox'
export * from './roles'
export * from './run'

export const SILITHID_VERSION = '0.0.0'
```

- [ ] **Step 2 : écrire les types Kysely**

`apps/server/src/db/types.ts` (remplace intégralement le stub) :

```ts
import type { AutonomyMode, InboxStatus, InboxType, RunState } from '@silithid/shared'
import type { ColumnType, Generated, JSONColumnType } from 'kysely'

/** Colonne écrite par la DB (default now()), jamais fournie à l'insert. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>

export interface UsersTable {
  id: Generated<string>
  login: string
  password_hash: string
  created_at: Generated<Timestamp>
}

export interface ClientsTable {
  id: Generated<string>
  name: string
  siret: string | null
  contacts: JSONColumnType<unknown[]>
  tone: string | null
  notes: JSONColumnType<unknown[]>
  secrets: JSONColumnType<Record<string, unknown>>
  created_at: Generated<Timestamp>
}

export interface ProjectsTable {
  id: Generated<string>
  client_id: string | null
  name: string
  slug: string
  repo_full_name: string
  default_branch: Generated<string>
  staging_url: string | null
  context: string | null
  autonomy_default: Generated<AutonomyMode>
  budget_weight: Generated<number>
  status: Generated<string>
  created_at: Generated<Timestamp>
}

export interface StepsTable {
  id: Generated<string>
  project_id: string
  position: number
  title: string
  specs: string
  autonomy: AutonomyMode | null
  max_iterations: Generated<number>
  budget_tokens: number | null
  status: Generated<'pending' | 'running' | 'awaiting_human' | 'validated' | 'failed'>
  created_at: Generated<Timestamp>
}

export interface RoleTemplatesTable {
  id: Generated<string>
  key: string
  project_type: Generated<string>
  version: Generated<number>
  system_prompt: string
  tools: JSONColumnType<unknown>
  model: string | null
}

export interface RolesTable {
  id: Generated<string>
  project_id: string
  template_id: string | null
  key: string
  system_prompt: string
  tools: JSONColumnType<unknown>
  model: string | null
  enabled: Generated<boolean>
}

export interface RunsTable {
  id: Generated<string>
  step_id: string
  iteration: Generated<number>
  state: Generated<RunState>
  branch: string | null
  pr_number: number | null
  worktree_path: string | null
  cost_tokens: Generated<string>
  started_at: Generated<Timestamp>
  ended_at: Timestamp | null
}

export interface AgentSessionsTable {
  id: Generated<string>
  run_id: string | null
  role_key: string
  sdk_session_id: string | null
  state: Generated<string>
  cost_tokens: Generated<string>
  created_at: Generated<Timestamp>
}

export interface MessagesTable {
  id: Generated<string>
  run_id: string | null
  from_role: string
  to_role: string
  kind: string
  body: string
  meta: JSONColumnType<Record<string, unknown>>
  created_at: Generated<Timestamp>
}

export interface InboxItemsTable {
  id: Generated<string>
  type: InboxType
  subtype: string | null
  project_id: string | null
  run_id: string | null
  title: string
  payload: JSONColumnType<Record<string, unknown>>
  status: Generated<InboxStatus>
  human_response: JSONColumnType<Record<string, unknown>> | null
  created_at: Generated<Timestamp>
  blocked_since: Generated<Timestamp>
  resolved_at: Timestamp | null
  archive_to_client: Generated<boolean>
}

export interface UsageWindowsTable {
  id: Generated<string>
  window_kind: '5h' | '7d'
  used_pct: string | null
  raw: JSONColumnType<Record<string, unknown>> | null
  sampled_at: Generated<Timestamp>
}

export interface ArtifactsTable {
  id: Generated<string>
  run_id: string | null
  kind: string
  path: string
  meta: JSONColumnType<Record<string, unknown>>
  created_at: Generated<Timestamp>
}

export interface SettingsTable {
  key: string
  // Un réglage peut valoir n'importe quel JSON, y compris un scalaire (70) —
  // pas seulement un objet. D'où `unknown` en lecture plutôt que
  // JSONColumnType, qui contraindrait à `object | null`.
  value: ColumnType<unknown, string, string>
  updated_at: Generated<Timestamp>
}

export interface Database {
  users: UsersTable
  clients: ClientsTable
  projects: ProjectsTable
  steps: StepsTable
  role_templates: RoleTemplatesTable
  roles: RolesTable
  runs: RunsTable
  agent_sessions: AgentSessionsTable
  messages: MessagesTable
  inbox_items: InboxItemsTable
  usage_windows: UsageWindowsTable
  artifacts: ArtifactsTable
  settings: SettingsTable
}
```

> `bigint` remonte en `string` avec le driver `pg` par défaut — d'où `Generated<string>` sur `cost_tokens`. Convertir avec `Number()` au moment de l'affichage, jamais en base.

- [ ] **Step 3 : écrire un test d'intégration qui exerce les types**

`apps/server/tests/db-types.test.ts` :

```ts
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts).
// Passer par databaseUrl() plutôt qu'une URL en dur : sinon un changement de
// configuration ferait tourner les tests contre une autre base sans le dire.
const pool = createPool(databaseUrl(loadEnv()))
const db = createDb(pool)

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
afterAll(async () => {
  await db.destroy()
})

test('insère un client, un projet et un step reliés', async () => {
  const client = await db
    .insertInto('clients')
    .values({ name: 'Acme', tone: 'direct' })
    .returningAll()
    .executeTakeFirstOrThrow()

  const project = await db
    .insertInto('projects')
    .values({
      client_id: client.id,
      name: 'Site Acme',
      slug: 'acme-site',
      repo_full_name: 'desura/acme',
      context: '# Contexte\nUn site vitrine.',
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  expect(project.autonomy_default).toBe('gated')
  expect(project.budget_weight).toBe(5)

  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'Header', specs: '## Specs' })
    .returningAll()
    .executeTakeFirstOrThrow()

  expect(step.status).toBe('pending')
  expect(step.max_iterations).toBe(4)
})

test('refuse un budget_weight hors bornes', async () => {
  await expect(
    db
      .insertInto('projects')
      .values({ name: 'X', slug: 'x', repo_full_name: 'a/b', budget_weight: 99 })
      .execute(),
  ).rejects.toThrow()
})
```

- [ ] **Step 4 : lancer et vérifier**

```bash
pnpm test && pnpm typecheck
```

Attendu : tous les tests passent, aucune erreur de type.

- [ ] **Step 5 : commit**

```bash
git add -A && git commit -m "feat(db): types Kysely de la base + unions partagées"
```

---

## Task 5 : Seeds des `role_templates`

**Files:**
- Create: `apps/server/src/db/seeds/role_templates/{majordome,garant,dev,reviewer,judge,communicant}.md`
- Create: `apps/server/src/db/seed.ts`
- Test: `apps/server/tests/seed.test.ts`

Le préambule commun (contexte projet, specs du step, fiche client, « français, direct, pas de flatterie ») est injecté à l'exécution par le moteur de boucles — il n'est pas dupliqué dans chaque prompt.

- [ ] **Step 1 : écrire les six prompts**

`majordome.md` :

```markdown
Tu es le Majordome de silithid : le bras droit transverse de Florian.

## Ton rôle
Tu as la vue d'ensemble sur tous les projets, tous les runs, l'inbox et le budget.
Tu réponds aux questions d'état et tu crées les projets en conversation.
Tu ne touches jamais au code, jamais à un dépôt, jamais à un déploiement.

## Création de projet (mode import)
Un projet importé existe déjà : un dépôt, souvent un staging. Tu collectes,
dans l'ordre et sans interrogatoire :
1. le dépôt (`owner/repo`) et la branche par défaut ;
2. l'URL de staging si elle existe ;
3. le client (existant ou nouveau : nom, contacts, ton de communication) ;
4. les premiers steps, avec pour chacun un titre et des critères d'acceptation ;
5. l'équipe de rôles recommandée, dérivée des templates.
Quand tu as de quoi proposer, appelle `create_project_draft` avec la fiche complète.
Ne crée jamais un projet dont tu ne peux pas remplir dépôt + au moins un step.

## Références d'entités
Chaque fois que tu mentionnes un projet, un run, un step ou un item d'inbox,
émets `entity_refs` avec leurs identifiants. C'est ce qui permet à l'interface
de mettre en avant ce dont tu parles.

## Style
Français. Direct. Pas de flatterie, pas de reformulation de la question.
Si une information manque, tu la demandes en une phrase.
```

`garant.md` :

```markdown
Tu es le Garant de ce projet : son chef de produit.

## Cadrage
On te donne les specs d'un step. Tu produis un prompt ciblé pour le développeur :
- l'objectif, en une phrase ;
- les contraintes techniques et produit qui s'appliquent ;
- les critères d'acceptation, formulés de façon vérifiable (« le formulaire
  refuse un email invalide », pas « le formulaire est robuste ») ;
- les pages ou écrans concernés, nommés explicitement — le juge visuel s'en sert.
Tu ne décris pas l'implémentation. Le développeur décide comment.

## Verdict
Après le rapport du reviewer et celui du juge visuel, tu rends l'un des deux :
- `conforme` : le step répond aux critères d'acceptation. Tu le dis sans réserve.
- `écarts` : tu listes les correctifs, du plus bloquant au moins bloquant, chacun
  rattaché au critère d'acceptation qu'il met en défaut. Puis tu produis les
  prompts correctifs pour l'itération suivante.
Un écart cosmétique non couvert par un critère d'acceptation n'est pas un écart :
signale-le en information, ne bloque pas dessus.

## Limites
Tu n'écris jamais de code. Tu ne lances jamais de déploiement.
Avant de poser une question à l'humain, consulte la fiche client (`client_kb.lookup`).

## Style
Français. Direct. Pas de flatterie.
```

`dev.md` :

```markdown
Tu es le développeur. Tu travailles dans un worktree git dédié à ce run.

## Ta tâche
Tu implémentes le prompt du garant. Tu suis les conventions du dépôt : lis le
code alentour avant d'écrire, respecte sa densité de commentaires, ses noms,
ses idiomes. Tu ne refactores pas ce qu'on ne t'a pas demandé de refactorer.

## Livraison
- Des commits atomiques, avec des messages qui disent le pourquoi.
- Une PR ouverte sur la branche du run, avec un corps qui résume le changement.
- Un rapport final : ce que tu as fait, et tes zones de doute — les endroits où
  tu as tranché sans certitude. Les zones de doute sont la partie utile.

## Questions
Tu peux émettre une `question`. Tu déclares toi-même si elle est bloquante :
- bloquante : tu ne peux pas continuer sans la réponse ;
- non bloquante : tu continues avec une hypothèse, que tu énonces.
Avant toute question, consulte la fiche client (`client_kb.lookup`) : la réponse
y est peut-être déjà.

## Communication client
Tu n'écris jamais directement au client. Si une communication est nécessaire,
tu la demandes au communicant via le bus de messages.

## Style
Français. Direct. Rapport factuel : si un test échoue, tu le dis avec sa sortie.
```

`reviewer.md` :

```markdown
Tu es le reviewer. Tu travailles dans un worktree propre, sur la PR du run.

## Ce que tu vérifies, dans cet ordre
1. **Conformité au prompt du garant.** Chaque critère d'acceptation est-il
   satisfait ? Nomme celui qui ne l'est pas.
2. **Exécution réelle des tests.** Tu les lances. Tu ne fais pas confiance au
   rapport du développeur sur ce point.
3. **Qualité du code.** Cohérence avec le dépôt, cas limites réellement
   atteignables, absence de code mort ou de complexité non justifiée.
4. **Cohérence visuelle** de l'implémentation par rapport aux specs.

## Verdict
`OK` ou `KO`. Un `KO` s'accompagne d'une liste actionnable : pour chaque point,
le fichier, la ligne, et ce qui doit changer. Pas de remarque de goût.
Tu as au maximum 3 allers-retours avec le développeur : à partir du troisième,
ne signale que ce qui est bloquant.

## Style
Français. Direct. Pas de compliment d'ouverture.
```

`judge.md` :

```markdown
Tu es le juge visuel. Tu reçois des captures Playwright (mobile 390, tablette 768,
desktop 1440) des pages du step, plus l'extraction texte du DOM.

## Ta tâche
Tu compares ce que tu vois aux specs et aux critères d'acceptation.
Tu décris. Tu ne décides pas : le verdict appartient au garant.

## Format de sortie
Un objet JSON, et rien d'autre :
{
  "conformites": ["<critère d'acceptation satisfait, cité>", ...],
  "ecarts": [
    {
      "severite": "bloquant" | "majeur" | "mineur",
      "page": "<url ou chemin>",
      "viewport": "mobile" | "tablette" | "desktop",
      "description": "<ce que tu observes, et le critère mis en défaut>",
      "screenshot_ref": "<identifiant de la capture>"
    }
  ]
}

## Calibrage des sévérités
- `bloquant` : un critère d'acceptation n'est pas satisfait, ou l'écran est
  inutilisable à ce viewport.
- `majeur` : l'intention des specs n'est pas respectée, sans casser l'usage.
- `mineur` : détail visuel non couvert par les specs.
Si tu ne peux pas trancher depuis la capture, dis-le dans la description plutôt
que de deviner.
```

`communicant.md` :

```markdown
Tu es le communicant. Tu rédiges les communications destinées au client.

## Ton
Tu prends le ton défini dans la fiche client. À défaut : professionnel, clair,
sans jargon technique. Le client n'a pas à connaître le vocabulaire du dépôt.

## Ce que tu produis
Un brouillon d'email : objet + corps. Rien d'autre.
Tu dis ce qui a été fait et ce que ça change pour le client. Tu ne promets pas
de date que personne ne t'a donnée. Tu n'inventes pas de contexte commercial.

## Limite absolue
Tu ne peux que **créer un brouillon**. Tu n'envoies jamais.
L'envoi est fait par le serveur, après validation humaine explicite.
Si tu penses qu'un email doit partir vite, tu le dis dans le brouillon ; tu ne
contournes pas la validation.

## Style
Français. Direct côté interne, adapté au client côté rédaction.
```

- [ ] **Step 2 : écrire le test qui échoue**

`apps/server/tests/seed.test.ts` :

```ts
import { ROLE_KEYS } from '@silithid/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { seedRoleTemplates } from '../src/db/seed'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts).
// Passer par databaseUrl() plutôt qu'une URL en dur : sinon un changement de
// configuration ferait tourner les tests contre une autre base sans le dire.
const pool = createPool(databaseUrl(loadEnv()))
const db = createDb(pool)

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
afterAll(async () => {
  await db.destroy()
})

test('insère les 6 templates generic v1 avec un prompt non vide', async () => {
  await seedRoleTemplates(db)
  const rows = await db.selectFrom('role_templates').selectAll().execute()

  expect(rows).toHaveLength(ROLE_KEYS.length)
  for (const key of ROLE_KEYS) {
    const row = rows.find((r) => r.key === key)
    expect(row, `template manquant : ${key}`).toBeDefined()
    expect(row?.project_type).toBe('generic')
    expect(row?.version).toBe(1)
    expect((row?.system_prompt ?? '').length).toBeGreaterThan(200)
  }
})

test('est idempotent : un second seed ne duplique pas', async () => {
  await seedRoleTemplates(db)
  const rows = await db.selectFrom('role_templates').selectAll().execute()
  expect(rows).toHaveLength(ROLE_KEYS.length)
})
```

- [ ] **Step 3 : lancer et vérifier l'échec**

```bash
pnpm test -- seed
```

Attendu : ÉCHEC, `Failed to resolve import "../src/db/seed"`.

- [ ] **Step 4 : implémenter le seed**

`apps/server/src/db/seed.ts` :

```ts
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLE_KEYS, type RoleKey } from '@silithid/shared'
import type { Kysely } from 'kysely'
import type { Database } from './types'

const SEEDS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'seeds', 'role_templates')

/** Politique d'outils par rôle. Consommée par le RuntimeAdapter (ToolPolicy). */
const TOOLS: Record<RoleKey, unknown> = {
  majordome: { bash: false, fs: 'none', mcp: ['db_read', 'create_project_draft'] },
  garant: { bash: false, fs: 'read', mcp: ['websearch', 'webfetch', 'client_kb', 'bus'] },
  dev: { bash: true, fs: 'write', mcp: ['git', 'gh', 'client_kb', 'bus'] },
  reviewer: { bash: true, fs: 'read', mcp: ['git', 'gh', 'bus'] },
  judge: { bash: false, fs: 'read', mcp: ['bus'] },
  communicant: { bash: false, fs: 'none', mcp: ['gmail_draft', 'client_kb', 'bus'] },
}

/**
 * Insère les templates de rôle `generic` v1. Idempotent : ré-exécuter met à jour
 * le prompt et les outils sans créer de doublon (clé unique key/project_type/version).
 */
export async function seedRoleTemplates(db: Kysely<Database>): Promise<void> {
  for (const key of ROLE_KEYS) {
    const systemPrompt = await readFile(join(SEEDS_DIR, `${key}.md`), 'utf8')
    await db
      .insertInto('role_templates')
      .values({
        key,
        project_type: 'generic',
        version: 1,
        system_prompt: systemPrompt,
        tools: JSON.stringify(TOOLS[key]),
        model: null,
      })
      .onConflict((oc) =>
        oc.columns(['key', 'project_type', 'version']).doUpdateSet({
          system_prompt: systemPrompt,
          tools: JSON.stringify(TOOLS[key]),
        }),
      )
      .execute()
  }
}

// Point d'entrée CLI : `pnpm db:seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb, closeDb } = await import('./client')
  await seedRoleTemplates(getDb())
  console.log(`${ROLE_KEYS.length} templates de rôle seedés.`)
  await closeDb()
}
```

- [ ] **Step 5 : relancer**

```bash
pnpm test
```

Attendu : tous les tests passent.

- [ ] **Step 6 : commit**

```bash
git add -A && git commit -m "feat(db): seed des 6 templates de rôle generic v1"
```

---

## Task 6 : Chiffrement applicatif des secrets (TDD)

**Files:**
- Create: `apps/server/src/crypto/secrets.ts`
- Test: `apps/server/tests/secrets.test.ts`

- [ ] **Step 1 : installer libsodium**

```bash
pnpm --filter @silithid/server add libsodium-wrappers && pnpm --filter @silithid/server add -D @types/libsodium-wrappers
```

- [ ] **Step 2 : écrire le test qui échoue**

`apps/server/tests/secrets.test.ts` :

```ts
import { expect, test } from 'vitest'
import { createSecretBox, generateMasterKey } from '../src/crypto/secrets'

test('un aller-retour restitue la valeur d origine', async () => {
  const box = await createSecretBox(generateMasterKey())
  const secret = { ftp_host: 'ftp.acme.fr', ftp_pass: 'hunter2' }

  const sealed = box.encryptJson(secret)
  expect(box.decryptJson(sealed)).toEqual(secret)
})

test('le chiffré ne contient jamais le clair', async () => {
  const box = await createSecretBox(generateMasterKey())
  const sealed = box.encryptJson({ ftp_pass: 'hunter2' })

  expect(sealed).not.toContain('hunter2')
  expect(sealed).not.toContain('ftp_pass')
})

test('deux chiffrements de la même valeur diffèrent (nonce aléatoire)', async () => {
  const box = await createSecretBox(generateMasterKey())
  expect(box.encryptJson({ a: 1 })).not.toBe(box.encryptJson({ a: 1 }))
})

test('une autre clé ne peut pas déchiffrer', async () => {
  const a = await createSecretBox(generateMasterKey())
  const b = await createSecretBox(generateMasterKey())

  expect(() => b.decryptJson(a.encryptJson({ a: 1 }))).toThrow(/déchiffrement/i)
})

test('un chiffré altéré est rejeté', async () => {
  const box = await createSecretBox(generateMasterKey())
  const sealed = box.encryptJson({ a: 1 })

  // Altération déterministe : on flippe un bit du dernier octet des données
  // décodées. Substituer des caractères base64 serait un no-op si le chiffré
  // se terminait déjà par la valeur de remplacement.
  const raw = Buffer.from(sealed, 'base64')
  const last = raw.length - 1
  raw[last] = (raw[last] as number) ^ 0x01
  const tampered = raw.toString('base64')

  expect(tampered).not.toBe(sealed)
  expect(() => box.decryptJson(tampered)).toThrow(/déchiffrement/i)
})

test('une clé de mauvaise taille est refusée à la construction', async () => {
  await expect(createSecretBox('dHJvcCBjb3VydA==')).rejects.toThrow(/32 octets/)
})
```

- [ ] **Step 3 : lancer et vérifier l'échec**

```bash
pnpm test -- secrets
```

Attendu : ÉCHEC, module introuvable.

- [ ] **Step 4 : implémenter**

`apps/server/src/crypto/secrets.ts` :

```ts
import sodium from 'libsodium-wrappers'

export interface SecretBox {
  encryptJson(value: unknown): string
  decryptJson<T = unknown>(sealed: string): T
}

/** Génère une clé maître de 32 octets en base64, à mettre dans MASTER_KEY. */
export function generateMasterKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
}

/**
 * Construit un chiffreur XSalsa20-Poly1305 (crypto_secretbox).
 * Le nonce est tiré au hasard à chaque chiffrement et préfixé au message ;
 * le tout est encodé en base64. Le chiffré est authentifié : toute altération
 * fait échouer le déchiffrement.
 */
export async function createSecretBox(masterKeyBase64: string): Promise<SecretBox> {
  await sodium.ready

  const key = Buffer.from(masterKeyBase64, 'base64')
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(
      `MASTER_KEY doit faire 32 octets une fois décodée en base64 (reçu : ${key.length}).`,
    )
  }

  return {
    encryptJson(value) {
      const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
      const cipher = sodium.crypto_secretbox_easy(
        Buffer.from(JSON.stringify(value), 'utf8'),
        nonce,
        key,
      )
      return Buffer.concat([Buffer.from(nonce), Buffer.from(cipher)]).toString('base64')
    },

    decryptJson<T>(sealed: string): T {
      const raw = Buffer.from(sealed, 'base64')
      const nonce = raw.subarray(0, sodium.crypto_secretbox_NONCEBYTES)
      const cipher = raw.subarray(sodium.crypto_secretbox_NONCEBYTES)
      let plain: Uint8Array
      try {
        plain = sodium.crypto_secretbox_open_easy(cipher, nonce, key)
      } catch {
        // Ne jamais laisser fuiter le chiffré ou la clé dans le message d'erreur.
        throw new Error('Échec du déchiffrement : clé invalide ou données altérées.')
      }
      return JSON.parse(Buffer.from(plain).toString('utf8')) as T
    },
  }
}
```

- [ ] **Step 5 : relancer**

```bash
pnpm test -- secrets
```

Attendu : les six tests passent.

- [ ] **Step 6 : commit**

```bash
git add -A && git commit -m "feat(crypto): chiffrement applicatif des secrets via libsodium"
```

---

## Task 7 : Authentification mono-utilisateur (TDD)

**Files:**
- Create: `apps/server/src/auth/password.ts`, `apps/server/src/auth/users.ts`, `apps/server/src/auth/session.ts`
- Create: `apps/server/src/app.ts`, `apps/server/src/index.ts`
- Create: `apps/server/src/api/routes/health.ts`, `apps/server/src/api/routes/auth.ts`
- Test: `apps/server/tests/auth.test.ts`

- [ ] **Step 1 : installer les dépendances**

```bash
pnpm --filter @silithid/server add @node-rs/argon2
```

- [ ] **Step 2 : écrire le test qui échoue**

`apps/server/tests/auth.test.ts` :

```ts
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../src/app'
import { createUser } from '../src/auth/users'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts).
// Passer par databaseUrl() plutôt qu'une URL en dur : sinon un changement de
// configuration ferait tourner les tests contre une autre base sans le dire.
const pool = createPool(databaseUrl(loadEnv()))
const db = createDb(pool)
const app = await buildApp({ db })

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
  await createUser(db, 'florian', 'motdepasse-de-test')
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

test('GET /api/health répond sans authentification', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toMatchObject({ status: 'ok' })
})

test('GET /api/me sans cookie renvoie 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/me' })
  expect(res.statusCode).toBe(401)
})

test('login avec un mauvais mot de passe renvoie 401 et aucun cookie', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'faux' },
  })
  expect(res.statusCode).toBe(401)
  expect(res.cookies).toHaveLength(0)
})

test('login avec un utilisateur inconnu renvoie 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'inconnu', password: 'motdepasse-de-test' },
  })
  expect(res.statusCode).toBe(401)
})

test('login valide puis /api/me avec le cookie', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  expect(login.statusCode).toBe(200)

  const cookie = login.cookies.find((c) => c.name === 'hm_session')
  expect(cookie).toBeDefined()
  expect(cookie?.httpOnly).toBe(true)
  expect(cookie?.sameSite?.toLowerCase()).toBe('lax')

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: { hm_session: cookie?.value as string },
  })
  expect(me.statusCode).toBe(200)
  expect(me.json()).toMatchObject({ login: 'florian' })
})

test('un cookie falsifié est rejeté', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: { hm_session: 'valeur-inventee' },
  })
  expect(res.statusCode).toBe(401)
})

test('logout invalide la session', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  const value = login.cookies.find((c) => c.name === 'hm_session')?.value as string

  const out = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    cookies: { hm_session: value },
  })
  expect(out.statusCode).toBe(200)
  expect(out.cookies.find((c) => c.name === 'hm_session')?.value).toBe('')
})

test('le hash du mot de passe n est jamais renvoyé par l API', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'florian', password: 'motdepasse-de-test' },
  })
  expect(login.body).not.toContain('$argon2')
})
```

- [ ] **Step 3 : lancer et vérifier l'échec**

```bash
pnpm test -- auth
```

Attendu : ÉCHEC, `../src/app` introuvable.

- [ ] **Step 4 : implémenter le hachage**

`apps/server/src/auth/password.ts` :

```ts
import { hash, verify } from '@node-rs/argon2'

// Paramètres OWASP 2024 pour argon2id.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS)
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTIONS)
  } catch {
    // Un hash mal formé en base ne doit pas faire tomber la route de login.
    return false
  }
}
```

- [ ] **Step 5 : implémenter le repo utilisateurs**

`apps/server/src/auth/users.ts` :

```ts
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { hashPassword, verifyPassword } from './password'

export interface PublicUser {
  id: string
  login: string
}

export async function createUser(
  db: Kysely<Database>,
  login: string,
  password: string,
): Promise<PublicUser> {
  const row = await db
    .insertInto('users')
    .values({ login, password_hash: await hashPassword(password) })
    .returning(['id', 'login'])
    .executeTakeFirstOrThrow()
  return row
}

export async function findUserById(
  db: Kysely<Database>,
  id: string,
): Promise<PublicUser | undefined> {
  return db.selectFrom('users').select(['id', 'login']).where('id', '=', id).executeTakeFirst()
}

/** Renvoie l'utilisateur si le couple est valide, `undefined` sinon. */
export async function authenticate(
  db: Kysely<Database>,
  login: string,
  password: string,
): Promise<PublicUser | undefined> {
  const row = await db
    .selectFrom('users')
    .select(['id', 'login', 'password_hash'])
    .where('login', '=', login)
    .executeTakeFirst()

  if (!row) {
    // Consommer le même temps CPU que pour un utilisateur existant.
    await hashPassword(password)
    return undefined
  }
  if (!(await verifyPassword(row.password_hash, password))) return undefined
  return { id: row.id, login: row.login }
}
```

- [ ] **Step 6 : implémenter le plugin de session**

`apps/server/src/auth/session.ts` :

```ts
import cookie from '@fastify/cookie'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { findUserById } from './users'
import type { PublicUser } from './users'

const COOKIE = 'hm_session'

declare module 'fastify' {
  interface FastifyRequest {
    user?: PublicUser
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export async function registerSession(
  app: FastifyInstance,
  opts: { db: Kysely<Database>; secret: string },
): Promise<void> {
  await app.register(cookie, { secret: opts.secret })

  app.decorateRequest('user', undefined)

  // Résout l'utilisateur à partir du cookie signé, sur toutes les requêtes.
  app.addHook('preHandler', async (req) => {
    const raw = req.cookies[COOKIE]
    if (!raw) return
    const unsigned = req.unsignCookie(raw)
    if (!unsigned.valid || !unsigned.value) return
    req.user = await findUserById(opts.db, unsigned.value)
  })

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: 'non_authentifie' })
    }
  })
}

export function setSessionCookie(reply: FastifyReply, userId: string): void {
  reply.setCookie(COOKIE, userId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30,
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' })
}
```

- [ ] **Step 7 : implémenter les routes et l'app**

`apps/server/src/api/routes/health.ts` :

```ts
import type { FastifyInstance } from 'fastify'

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok', at: new Date().toISOString() }))
}
```

`apps/server/src/api/routes/auth.ts` :

```ts
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from '../../db/types'
import { clearSessionCookie, setSessionCookie } from '../../auth/session'
import { authenticate } from '../../auth/users'

const loginBody = z.object({ login: z.string().min(1), password: z.string().min(1) })

export async function authRoutes(app: FastifyInstance, opts: { db: Kysely<Database> }) {
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'requete_invalide' })

    const user = await authenticate(opts.db, parsed.data.login, parsed.data.password)
    if (!user) return reply.code(401).send({ error: 'identifiants_invalides' })

    setSessionCookie(reply, user.id)
    return { id: user.id, login: user.login }
  })

  app.post('/api/auth/logout', async (_req, reply) => {
    clearSessionCookie(reply)
    return { ok: true }
  })

  app.get('/api/me', { preHandler: app.requireAuth }, async (req) => req.user)
}
```

`apps/server/src/app.ts` :

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { registerSession } from './auth/session'
import type { Database } from './db/types'
import { authRoutes } from './api/routes/auth'
import { healthRoutes } from './api/routes/health'
import { loadEnv } from './env'

export interface AppDeps {
  db: Kysely<Database>
}

/** Construit l'instance Fastify sans l'écouter — utilisable tel quel en test. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const env = loadEnv()
  const app = Fastify({ logger: env.NODE_ENV !== 'test' })

  await registerSession(app, { db: deps.db, secret: env.SESSION_SECRET })
  await app.register(healthRoutes)
  await app.register(authRoutes, { db: deps.db })

  return app
}
```

`apps/server/src/index.ts` :

```ts
import { buildApp } from './app'
import { getDb } from './db/client'
import { loadEnv } from './env'

const env = loadEnv()
const app = await buildApp({ db: getDb() })

await app.listen({ port: env.PORT, host: '0.0.0.0' })
```

- [ ] **Step 8 : créer l'utilisateur local et relancer les tests**

```bash
pnpm test -- auth
```

Attendu : les huit tests passent.

- [ ] **Step 9 : vérifier le serveur à la main**

```bash
pnpm dev
```

Puis dans un autre terminal :

```bash
curl -s localhost:3000/api/health
```

Attendu : `{"status":"ok","at":"..."}`.

- [ ] **Step 10 : commit**

```bash
git add -A && git commit -m "feat(auth): session mono-utilisateur par cookie signé + argon2"
```

---

## Task 8 : Store de réglages avec secrets chiffrés (TDD)

**Files:**
- Create: `apps/server/src/settings/store.ts`
- Create: `apps/server/src/api/routes/settings.ts`
- Modify: `apps/server/src/app.ts` (enregistre la route)
- Test: `apps/server/tests/settings.test.ts`

Certains réglages sont des secrets (mot de passe SMTP, PAT GitHub). Ils sont stockés chiffrés dans `settings.value` et **jamais** renvoyés par l'API.

- [ ] **Step 1 : écrire le test qui échoue**

`apps/server/tests/settings.test.ts` :

```ts
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createSecretBox, generateMasterKey } from '../src/crypto/secrets'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { createSettingsStore } from '../src/settings/store'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts).
// Passer par databaseUrl() plutôt qu'une URL en dur : sinon un changement de
// configuration ferait tourner les tests contre une autre base sans le dire.
const pool = createPool(databaseUrl(loadEnv()))
const db = createDb(pool)

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
afterAll(async () => {
  await db.destroy()
})

async function store() {
  return createSettingsStore(db, await createSecretBox(generateMasterKey()))
}

test('un réglage en clair fait l aller-retour', async () => {
  const s = await store()
  await s.set('budget.day_threshold_pct', 70)
  expect(await s.get('budget.day_threshold_pct')).toBe(70)
})

test('set écrase la valeur précédente', async () => {
  const s = await store()
  await s.set('budget.day_threshold_pct', 70)
  await s.set('budget.day_threshold_pct', 85)
  expect(await s.get('budget.day_threshold_pct')).toBe(85)
})

test('une clé absente renvoie undefined', async () => {
  const s = await store()
  expect(await s.get('inexistant')).toBeUndefined()
})

test('un secret est chiffré en base et relisible par le store', async () => {
  const s = await store()
  await s.setSecret('smtp.pass', 'hunter2')

  const raw = await db
    .selectFrom('settings')
    .select('value')
    .where('key', '=', 'smtp.pass')
    .executeTakeFirstOrThrow()

  expect(JSON.stringify(raw.value)).not.toContain('hunter2')
  expect(await s.getSecret('smtp.pass')).toBe('hunter2')
})

test('listPublic masque les secrets et expose les clairs', async () => {
  const s = await store()
  await s.set('budget.day_threshold_pct', 70)
  await s.setSecret('smtp.pass', 'hunter2')

  const listed = await s.listPublic()
  expect(listed['budget.day_threshold_pct']).toBe(70)
  expect(listed['smtp.pass']).toBe('***')
  expect(JSON.stringify(listed)).not.toContain('hunter2')
})
```

- [ ] **Step 2 : lancer et vérifier l'échec**

```bash
pnpm test -- settings
```

Attendu : ÉCHEC, module introuvable.

- [ ] **Step 3 : implémenter le store**

`apps/server/src/settings/store.ts` :

```ts
import type { Kysely } from 'kysely'
import type { SecretBox } from '../crypto/secrets'
import type { Database } from '../db/types'

/** Enveloppe stockée pour les valeurs secrètes. */
interface SealedValue {
  __sealed: true
  data: string
}

function isSealed(value: unknown): value is SealedValue {
  return typeof value === 'object' && value !== null && '__sealed' in value
}

export interface SettingsStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  getSecret(key: string): Promise<string | undefined>
  setSecret(key: string, value: string): Promise<void>
  /** Tous les réglages, secrets remplacés par `***`. Sûr à renvoyer par l'API. */
  listPublic(): Promise<Record<string, unknown>>
}

export function createSettingsStore(db: Kysely<Database>, box: SecretBox): SettingsStore {
  async function readRaw(key: string): Promise<unknown> {
    const row = await db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst()
    return row?.value
  }

  async function writeRaw(key: string, value: unknown): Promise<void> {
    await db
      .insertInto('settings')
      .values({ key, value: JSON.stringify(value) })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: new Date() }),
      )
      .execute()
  }

  return {
    async get<T>(key: string) {
      const value = await readRaw(key)
      if (value === undefined || isSealed(value)) return undefined
      return value as T
    },

    set: writeRaw,

    async getSecret(key) {
      const value = await readRaw(key)
      if (!isSealed(value)) return undefined
      return box.decryptJson<string>(value.data)
    },

    async setSecret(key, value) {
      await writeRaw(key, { __sealed: true, data: box.encryptJson(value) } satisfies SealedValue)
    },

    async listPublic() {
      const rows = await db.selectFrom('settings').selectAll().execute()
      const out: Record<string, unknown> = {}
      for (const row of rows) {
        out[row.key] = isSealed(row.value) ? '***' : row.value
      }
      return out
    },
  }
}
```

- [ ] **Step 4 : exposer la route**

`apps/server/src/api/routes/settings.ts` :

```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SettingsStore } from '../../settings/store'

const body = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  secret: z.boolean().default(false),
})

export async function settingsRoutes(app: FastifyInstance, opts: { settings: SettingsStore }) {
  app.get('/api/settings', { preHandler: app.requireAuth }, async () => opts.settings.listPublic())

  app.put('/api/settings', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'requete_invalide' })

    if (parsed.data.secret) {
      if (typeof parsed.data.value !== 'string') {
        return reply.code(400).send({ error: 'un_secret_doit_etre_une_chaine' })
      }
      await opts.settings.setSecret(parsed.data.key, parsed.data.value)
    } else {
      await opts.settings.set(parsed.data.key, parsed.data.value)
    }
    return { ok: true }
  })
}
```

Dans `apps/server/src/app.ts`, remplacer le corps de `buildApp` par :

```ts
export interface AppDeps {
  db: Kysely<Database>
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const env = loadEnv()
  const app = Fastify({ logger: env.NODE_ENV !== 'test' })
  const settings = createSettingsStore(deps.db, await createSecretBox(env.MASTER_KEY))

  await registerSession(app, { db: deps.db, secret: env.SESSION_SECRET })
  await app.register(healthRoutes)
  await app.register(authRoutes, { db: deps.db })
  await app.register(settingsRoutes, { settings })

  return app
}
```

avec les imports ajoutés en tête :

```ts
import { createSecretBox } from './crypto/secrets'
import { createSettingsStore } from './settings/store'
import { settingsRoutes } from './api/routes/settings'
```

- [ ] **Step 5 : relancer**

```bash
pnpm test && pnpm typecheck
```

Attendu : tout passe.

- [ ] **Step 6 : commit**

```bash
git add -A && git commit -m "feat(settings): store de réglages avec secrets chiffrés et masqués"
```

---

## Task 9 : Interface `RuntimeAdapter` + `FakeAdapter` (TDD)

**Files:**
- Create: `apps/server/src/runtime/types.ts`
- Create: `apps/server/src/runtime/fake.ts`
- Create: `apps/server/src/runtime/index.ts`
- Test: `apps/server/tests/runtime-fake.test.ts`

C'est le contrat que toutes les phases suivantes consomment. Il est écrit **avant** l'implémentation Claude, pour que rien dans le moteur de boucles ne dépende du SDK.

- [ ] **Step 1 : écrire l'interface**

`apps/server/src/runtime/types.ts` :

```ts
import type { RoleKey } from '@silithid/shared'

/** Ce qu'un rôle a le droit de faire. Traduit en options SDK par l'adapter. */
export interface ToolPolicy {
  /** Autorise l'exécution de commandes shell. */
  bash: boolean
  /** Accès système de fichiers dans le cwd de la session. */
  fs: 'none' | 'read' | 'write'
  /** Allowlist de serveurs/outils MCP exposés au rôle. */
  mcp: string[]
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'cost'; tokens: number }

export interface AgentSession {
  /** Identifiant local (le nôtre), stable pour toute la vie de la session. */
  id: string
  roleKey: RoleKey
  cwd: string
  /** Identifiant de session côté SDK, connu après le premier échange. */
  sdkSessionId?: string
}

export interface AgentResult {
  /** Texte final produit par l'agent. */
  text: string
  costTokens: number
  /** Vrai si la session s'est terminée en erreur côté SDK. */
  isError: boolean
}

export interface CreateSessionOptions {
  roleKey: RoleKey
  systemPrompt: string
  model?: string
  /** Worktree du run : tout accès fichier est relatif à ce répertoire. */
  cwd: string
  tools: ToolPolicy
  onEvent: (e: AgentEvent) => void
}

/**
 * Consommation du compte, par fenêtre. `available: false` signifie que le
 * runtime n'expose pas l'information — le scheduler de budget ne doit alors
 * jamais mettre un projet en pause.
 */
export interface UsageSnapshot {
  fiveHourPct: number
  sevenDayPct: number
  available: boolean
}

export interface HealthcheckResult {
  ok: boolean
  error?: string
}

export interface RuntimeAdapter {
  /**
   * Vérifie que le runtime est réellement joignable et authentifié.
   *
   * Méthode distincte de `createSession` à dessein : côté Claude, ouvrir une
   * session ne déclenche aucun appel réseau (le premier échange a lieu dans
   * `send`), donc s'appuyer dessus produirait un healthcheck qui répond
   * toujours « ok », y compris avec un token expiré.
   */
  healthcheck(): Promise<HealthcheckResult>
  createSession(opts: CreateSessionOptions): Promise<AgentSession>
  send(session: AgentSession, message: string): Promise<AgentResult>
  resume(sessionId: string): Promise<AgentSession | null>
  usage(): Promise<UsageSnapshot>
}
```

> **`healthcheck()` a été ajouté à l'interface pendant la Task 11**, pas prévu au départ. Le plan initial faisait ouvrir une session au healthcheck en supposant que ça suffirait à valider l'authentification — c'est faux avec le `ClaudeAdapter`, dont `createSession` est purement local. Détecter une auth cassée suppose de parler au service : `ClaudeAdapter.healthcheck()` fait donc un échange minimal (pas d'outils, un mot en réponse, ~5 s). À la cadence du cron de 15 minutes, le coût est négligeable devant celui d'une panne d'authentification passée inaperçue.
>
> Le `FakeAdapter` accepte une option `healthcheckError?: string` pour simuler la panne dans les tests.

- [ ] **Step 2 : écrire le test qui échoue**

`apps/server/tests/runtime-fake.test.ts` :

```ts
import { expect, test } from 'vitest'
import { createFakeAdapter } from '../src/runtime/fake'
import type { AgentEvent } from '../src/runtime/types'

const baseOpts = {
  roleKey: 'dev' as const,
  systemPrompt: 'Tu es un développeur.',
  cwd: '/tmp/worktree-test',
  tools: { bash: true, fs: 'write' as const, mcp: [] },
}

test('createSession renvoie une session identifiée', async () => {
  const adapter = createFakeAdapter()
  const session = await adapter.createSession({ ...baseOpts, onEvent: () => {} })

  expect(session.id).toMatch(/^fake-/)
  expect(session.roleKey).toBe('dev')
  expect(session.cwd).toBe('/tmp/worktree-test')
})

test('send renvoie la réponse scriptée et émet des évènements', async () => {
  const adapter = createFakeAdapter({ replies: ['première', 'deuxième'] })
  const events: AgentEvent[] = []
  const session = await adapter.createSession({ ...baseOpts, onEvent: (e) => events.push(e) })

  const first = await adapter.send(session, 'salut')
  expect(first.text).toBe('première')
  expect(first.isError).toBe(false)
  expect(first.costTokens).toBeGreaterThan(0)

  const second = await adapter.send(session, 'et ensuite ?')
  expect(second.text).toBe('deuxième')

  expect(events.some((e) => e.type === 'text')).toBe(true)
  expect(events.some((e) => e.type === 'cost')).toBe(true)
})

test('send au-delà du script renvoie une réponse par défaut', async () => {
  const adapter = createFakeAdapter({ replies: ['une seule'] })
  const session = await adapter.createSession({ ...baseOpts, onEvent: () => {} })
  await adapter.send(session, 'a')

  const overflow = await adapter.send(session, 'b')
  expect(overflow.text).toContain('[fake]')
})

test('resume retrouve une session existante, pas une inconnue', async () => {
  const adapter = createFakeAdapter()
  const session = await adapter.createSession({ ...baseOpts, onEvent: () => {} })

  expect(await adapter.resume(session.id)).toMatchObject({ id: session.id })
  expect(await adapter.resume('inconnue')).toBeNull()
})

test('usage se déclare indisponible par défaut', async () => {
  expect(await createFakeAdapter().usage()).toEqual({
    fiveHourPct: 0,
    sevenDayPct: 0,
    available: false,
  })
})

test('usage renvoie les valeurs injectées', async () => {
  const adapter = createFakeAdapter({ usage: { fiveHourPct: 80, sevenDayPct: 12 } })
  expect(await adapter.usage()).toEqual({ fiveHourPct: 80, sevenDayPct: 12, available: true })
})
```

- [ ] **Step 3 : lancer et vérifier l'échec**

```bash
pnpm test -- runtime-fake
```

Attendu : ÉCHEC, module introuvable.

- [ ] **Step 4 : implémenter le FakeAdapter**

`apps/server/src/runtime/fake.ts` :

```ts
import { randomUUID } from 'node:crypto'
import type {
  AgentResult,
  AgentSession,
  CreateSessionOptions,
  RuntimeAdapter,
  UsageSnapshot,
} from './types'

export interface FakeAdapterOptions {
  /** Réponses renvoyées dans l'ordre, une par appel à send(). */
  replies?: string[]
  usage?: { fiveHourPct: number; sevenDayPct: number }
}

/**
 * Adapter déterministe pour les tests et le développement hors ligne.
 * Ne fait aucun appel réseau et ne consomme aucun token.
 */
export function createFakeAdapter(opts: FakeAdapterOptions = {}): RuntimeAdapter {
  const sessions = new Map<string, { session: AgentSession; onEvent: CreateSessionOptions['onEvent'] }>()
  const replies = [...(opts.replies ?? [])]
  let cursor = 0

  return {
    async createSession(options) {
      const session: AgentSession = {
        id: `fake-${randomUUID()}`,
        roleKey: options.roleKey,
        cwd: options.cwd,
      }
      sessions.set(session.id, { session, onEvent: options.onEvent })
      return session
    },

    async send(session, message): Promise<AgentResult> {
      const entry = sessions.get(session.id)
      const text = replies[cursor++] ?? `[fake] réponse à : ${message}`
      const costTokens = message.length + text.length

      entry?.onEvent({ type: 'text', text })
      entry?.onEvent({ type: 'cost', tokens: costTokens })

      return { text, costTokens, isError: false }
    },

    async resume(sessionId) {
      return sessions.get(sessionId)?.session ?? null
    },

    async usage(): Promise<UsageSnapshot> {
      if (!opts.usage) return { fiveHourPct: 0, sevenDayPct: 0, available: false }
      return { ...opts.usage, available: true }
    },
  }
}
```

`apps/server/src/runtime/index.ts` :

```ts
import type { Env } from '../env'
import { createFakeAdapter } from './fake'
import type { RuntimeAdapter } from './types'

export async function createRuntimeAdapter(env: Env): Promise<RuntimeAdapter> {
  if (env.RUNTIME_ADAPTER === 'fake') return createFakeAdapter()
  const { createClaudeAdapter } = await import('./claude')
  return createClaudeAdapter()
}

export type * from './types'
```

> `createRuntimeAdapter` importe `./claude` en dynamique : à l'exécution, `RUNTIME_ADAPTER=fake` ne charge jamais le SDK.
>
> **Mais `tsc` résout aussi les imports dynamiques** (`TS2307: Cannot find module './claude'`) — il faut donc créer dès cette tâche un bouchon `apps/server/src/runtime/claude.ts` qui exporte `createClaudeAdapter(): RuntimeAdapter` et lève `Error('ClaudeAdapter non implémenté (Task 10)')`. La Task 10 le remplace intégralement. L'alternative — masquer l'import derrière une variable pour échapper à la résolution statique — typerait `createClaudeAdapter` en `any` et ferait perdre la vérification à la Task 10 : ne pas la prendre.

- [ ] **Step 5 : relancer**

```bash
pnpm test -- runtime-fake
```

Attendu : les six tests passent.

- [ ] **Step 6 : commit**

```bash
git add -A && git commit -m "feat(runtime): interface RuntimeAdapter + FakeAdapter déterministe"
```

---

## Task 10 : `ClaudeAdapter` sur l'Agent SDK

**Files:**
- Create: `apps/server/src/runtime/claude.ts`
- Create: `apps/server/src/runtime/worktree.ts`
- Create: `apps/server/scripts/smoke-agent.ts`

Cette tâche appelle un vrai modèle : elle consomme des tokens et ne peut pas être vérifiée par un test automatisé en CI. La vérification est manuelle et scriptée.

- [ ] **Step 1 : installer le SDK et inspecter ses types**

```bash
pnpm --filter @silithid/server add @anthropic-ai/claude-agent-sdk
```

Puis **lire les types réellement installés avant d'écrire une ligne** :

```bash
ls node_modules/@anthropic-ai/claude-agent-sdk/ && sed -n '1,200p' node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

Trois choses à en tirer, notées dans un commentaire en tête de `claude.ts` :
1. la signature exacte de `query()` et le nom des options (`cwd`, `systemPrompt`, `model`, `allowedTools`, `permissionMode`, `resume`) ;
2. la forme des messages du flux — en particulier où se trouvent `session_id` et, sur le message final, `usage` / `total_cost_usd` ;
3. **s'il existe une API de consommation par fenêtre (5 h / 7 j).** Si elle n'existe pas, `usage()` retourne `{ fiveHourPct: 0, sevenDayPct: 0, available: false }` — ne pas inventer de valeurs, ne pas taper une URL non documentée.

- [ ] **Step 2 : écrire l'utilitaire de worktree**

`apps/server/src/runtime/worktree.ts` :

```ts
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface DisposableWorktree {
  path: string
  dispose(): Promise<void>
}

/**
 * Crée un dépôt git jetable dans /tmp, avec un commit initial.
 * Utilisé par le smoke test de la Task 10 ; les worktrees rattachés à un vrai
 * dépôt arrivent en Phase 2 avec le moteur de boucles.
 */
export async function createThrowawayRepo(): Promise<DisposableWorktree> {
  const path = await mkdtemp(join(tmpdir(), 'silithid-smoke-'))
  await run('git', ['init', '-b', 'main'], { cwd: path })
  await run('git', ['config', 'user.email', 'silithid@local'], { cwd: path })
  await run('git', ['config', 'user.name', 'silithid'], { cwd: path })
  await run('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: path })
  return {
    path,
    dispose: () => rm(path, { recursive: true, force: true }),
  }
}
```

- [ ] **Step 3 : implémenter l'adapter**

`apps/server/src/runtime/claude.ts` — squelette à **réconcilier avec les types lus au Step 1** ; les noms de champs marqués `// ⚠ vérifier` sont ceux à confirmer.

```ts
import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentResult,
  AgentSession,
  CreateSessionOptions,
  RuntimeAdapter,
  ToolPolicy,
  UsageSnapshot,
} from './types'

/** Traduit notre politique d'outils en allowlist SDK. */
function allowedTools(policy: ToolPolicy): string[] {
  const tools: string[] = []
  if (policy.bash) tools.push('Bash')
  if (policy.fs !== 'none') tools.push('Read', 'Glob', 'Grep')
  if (policy.fs === 'write') tools.push('Write', 'Edit')
  tools.push(...policy.mcp.map((name) => `mcp__${name}`))
  return tools
}

interface Live {
  session: AgentSession
  options: CreateSessionOptions
}

export function createClaudeAdapter(): RuntimeAdapter {
  const live = new Map<string, Live>()

  return {
    async createSession(options) {
      const session: AgentSession = {
        id: `claude-${randomUUID()}`,
        roleKey: options.roleKey,
        cwd: options.cwd,
      }
      live.set(session.id, { session, options })
      return session
    },

    async send(session, message): Promise<AgentResult> {
      const entry = live.get(session.id)
      if (!entry) throw new Error(`Session inconnue : ${session.id}`)
      const { options } = entry

      let text = ''
      let costTokens = 0
      let isError = false

      const stream = query({
        prompt: message,
        options: {
          cwd: options.cwd,
          systemPrompt: options.systemPrompt,
          ...(options.model ? { model: options.model } : {}),
          allowedTools: allowedTools(options.tools),
          // Reprend la conversation quand le SDK nous a déjà donné un identifiant.
          ...(session.sdkSessionId ? { resume: session.sdkSessionId } : {}),
        },
      })

      for await (const msg of stream) {
        // ⚠ vérifier : le message d'init porte session_id
        if ('session_id' in msg && msg.session_id) {
          session.sdkSessionId = msg.session_id as string
        }

        if (msg.type === 'assistant') {
          // ⚠ vérifier : forme des blocs de contenu
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              text += block.text
              options.onEvent({ type: 'text', text: block.text })
            } else if (block.type === 'tool_use') {
              options.onEvent({ type: 'tool_use', name: block.name, input: block.input })
            }
          }
        }

        if (msg.type === 'result') {
          // ⚠ vérifier : nom du champ usage sur le message final
          const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
          costTokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
          isError = (msg as { is_error?: boolean }).is_error === true
          options.onEvent({ type: 'cost', tokens: costTokens })
        }
      }

      return { text, costTokens, isError }
    },

    async resume(sessionId) {
      return live.get(sessionId)?.session ?? null
    },

    async usage(): Promise<UsageSnapshot> {
      // Le SDK n'expose pas les fenêtres 5h/7j (vérifié au Step 1).
      // Tant que ce n'est pas le cas, on se déclare indisponible plutôt que
      // d'alimenter le scheduler de budget avec des chiffres inventés.
      return { fiveHourPct: 0, sevenDayPct: 0, available: false }
    },
  }
}
```

- [ ] **Step 4 : écrire le smoke test manuel**

`apps/server/scripts/smoke-agent.ts` :

```ts
/**
 * Vérification manuelle de la Task 10 : un agent réel écrit un fichier
 * dans un dépôt jetable, et on constate le résultat sur le disque.
 * Consomme des tokens. Lancer avec : pnpm --filter @silithid/server exec tsx scripts/smoke-agent.ts
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClaudeAdapter } from '../src/runtime/claude'
import { createThrowawayRepo } from '../src/runtime/worktree'

const repo = await createThrowawayRepo()
console.log(`Worktree : ${repo.path}`)

const adapter = createClaudeAdapter()
const session = await adapter.createSession({
  roleKey: 'dev',
  systemPrompt: 'Tu es un développeur. Français, direct, pas de flatterie.',
  cwd: repo.path,
  tools: { bash: false, fs: 'write', mcp: [] },
  onEvent: (e) => {
    if (e.type === 'text') process.stdout.write(e.text)
    if (e.type === 'tool_use') console.log(`\n[outil] ${e.name}`)
    if (e.type === 'cost') console.log(`\n[coût] ${e.tokens} tokens`)
  },
})

const result = await adapter.send(
  session,
  "Crée un fichier BONJOUR.md contenant exactement la ligne « silithid est vivant ». Puis réponds 'fait'.",
)

console.log(`\n--- Résultat : isError=${result.isError}, coût=${result.costTokens}`)
console.log(`--- sdkSessionId : ${session.sdkSessionId ?? '(non fourni)'}`)

const content = await readFile(join(repo.path, 'BONJOUR.md'), 'utf8').catch(() => null)
if (content?.includes('silithid est vivant')) {
  console.log('✅ Le fichier a bien été écrit dans le worktree.')
} else {
  console.error('❌ BONJOUR.md absent ou incorrect. Contenu lu :', content)
  process.exitCode = 1
}

await repo.dispose()
```

- [ ] **Step 5 : lancer le smoke test**

```bash
pnpm --filter @silithid/server exec tsx scripts/smoke-agent.ts
```

Attendu : le texte de l'agent s'affiche en streaming, puis `✅ Le fichier a bien été écrit dans le worktree.`

**En cas d'échec :** le message d'erreur du SDK dit lequel des trois points du Step 1 était faux. Corriger `claude.ts` en fonction des types réels, pas en tâtonnant sur les noms de champs. Si l'échec est une erreur d'authentification, c'est la session `claude` locale qui n'est pas valide → se reconnecter et relancer.

- [ ] **Step 6 : vérifier que le typecheck et la suite passent toujours**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 7 : commit**

```bash
git add -A && git commit -m "feat(runtime): ClaudeAdapter sur l Agent SDK + smoke test en worktree jetable"
```

---

## Task 11 : Mailer d'alertes et healthcheck d'authentification (TDD)

**Files:**
- Create: `apps/server/src/integrations/mailer.ts`
- Create: `apps/server/src/health/auth-check.ts`
- Modify: `apps/server/src/api/routes/health.ts`
- Test: `apps/server/tests/auth-check.test.ts`

Le healthcheck détecte un token agent devenu invalide et lève une alerte (item d'inbox + email SMTP). La **planification** (cron 15 min) arrive en Phase 2 avec pg-boss ; ici on écrit la fonction et on l'expose sur une route.

- [ ] **Step 1 : installer nodemailer**

```bash
pnpm --filter @silithid/server add nodemailer && pnpm --filter @silithid/server add -D @types/nodemailer
```

- [ ] **Step 2 : implémenter le mailer**

`apps/server/src/integrations/mailer.ts` :

```ts
import { createTransport } from 'nodemailer'
import type { Env } from '../env'

export interface Mail {
  to: string
  subject: string
  text: string
}

export interface Mailer {
  send(mail: Mail): Promise<void>
  /** Emails capturés en mode dry-run — pour les tests et l'inspection en dev. */
  readonly sent: readonly Mail[]
}

/**
 * En MAIL_DRY_RUN=1 (défaut en dev), rien ne part : l'email est loggé et gardé
 * en mémoire. C'est la garantie qu'aucun mail réel ne fuit pendant le sprint.
 */
export function createMailer(env: Env): Mailer {
  const sent: Mail[] = []

  if (env.MAIL_DRY_RUN === 1) {
    return {
      sent,
      async send(mail) {
        sent.push(mail)
        console.log(`[MAIL_DRY_RUN] à=${mail.to} objet="${mail.subject}"\n${mail.text}`)
      },
    }
  }

  if (!env.SMTP_HOST) throw new Error('SMTP_HOST requis quand MAIL_DRY_RUN=0')

  const transport = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
  })

  return {
    sent,
    async send(mail) {
      await transport.sendMail({ from: env.ALERT_EMAIL_FROM, ...mail })
    },
  }
}
```

- [ ] **Step 3 : écrire le test qui échoue**

`apps/server/tests/auth-check.test.ts` :

```ts
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { runAuthHealthcheck } from '../src/health/auth-check'
import type { Mail, Mailer } from '../src/integrations/mailer'
import { createFakeAdapter } from '../src/runtime/fake'
import type { RuntimeAdapter } from '../src/runtime/types'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts).
// Passer par databaseUrl() plutôt qu'une URL en dur : sinon un changement de
// configuration ferait tourner les tests contre une autre base sans le dire.
const pool = createPool(databaseUrl(loadEnv()))
const db = createDb(pool)

function fakeMailer(): Mailer {
  const sent: Mail[] = []
  return { sent, async send(m) { sent.push(m) } }
}

/** Adapter dont createSession échoue : simule un token expiré. */
function brokenAdapter(): RuntimeAdapter {
  const base = createFakeAdapter()
  return { ...base, createSession: async () => { throw new Error('OAuth token expired') } }
}

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
beforeEach(async () => {
  await db.deleteFrom('inbox_items').execute()
})
afterAll(async () => {
  await db.destroy()
})

test('runtime sain : ok, aucune alerte, aucun email', async () => {
  const mailer = fakeMailer()
  const result = await runAuthHealthcheck({
    db,
    adapter: createFakeAdapter(),
    mailer,
    alertTo: 'alerts@exemple.test',
  })

  expect(result.ok).toBe(true)
  expect(mailer.sent).toHaveLength(0)
  expect(await db.selectFrom('inbox_items').selectAll().execute()).toHaveLength(0)
})

test('runtime cassé : crée une alerte inbox et envoie un email', async () => {
  const mailer = fakeMailer()
  const result = await runAuthHealthcheck({
    db,
    adapter: brokenAdapter(),
    mailer,
    alertTo: 'alerts@exemple.test',
  })

  expect(result.ok).toBe(false)
  expect(result.error).toContain('OAuth token expired')

  const items = await db.selectFrom('inbox_items').selectAll().execute()
  expect(items).toHaveLength(1)
  expect(items[0]?.type).toBe('alert')
  expect(items[0]?.status).toBe('open')

  expect(mailer.sent).toHaveLength(1)
  expect(mailer.sent[0]?.to).toBe('alerts@exemple.test')
})

test('ne crée pas de doublon tant que l alerte précédente est ouverte', async () => {
  const mailer = fakeMailer()
  const opts = { db, adapter: brokenAdapter(), mailer, alertTo: 'alerts@exemple.test' }

  await runAuthHealthcheck(opts)
  await runAuthHealthcheck(opts)

  expect(await db.selectFrom('inbox_items').selectAll().execute()).toHaveLength(1)
  expect(mailer.sent).toHaveLength(1)
})
```

- [ ] **Step 4 : lancer et vérifier l'échec**

```bash
pnpm test -- auth-check
```

Attendu : ÉCHEC, `../src/health/auth-check` introuvable.

- [ ] **Step 5 : implémenter le healthcheck**

`apps/server/src/health/auth-check.ts` :

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import type { Mailer } from '../integrations/mailer'
import type { RuntimeAdapter } from '../runtime/types'

const ALERT_KEY = 'auth.runtime_indisponible'

export interface AuthHealthcheckResult {
  ok: boolean
  error?: string
}

export interface AuthHealthcheckDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  mailer: Mailer
  alertTo: string
}

/**
 * Vérifie que le runtime agent est réellement joignable et authentifié, en
 * déléguant à `adapter.healthcheck()`.
 *
 * L'appel est borné dans le temps : un runtime injoignable fait pendre le SDK
 * (réessais réseau) au lieu d'échouer, ce qui bloquerait le cron de 15 minutes
 * indéfiniment — l'outil resterait muet exactement quand il devrait alerter.
 * Un dépassement de délai est traité comme une panne, pas comme un doute.
 *
 * En cas d'échec : un item d'inbox `alert` + un email immédiat. L'alerte n'est
 * pas dupliquée tant qu'une alerte de même cause est encore ouverte.
 */
export async function runAuthHealthcheck(
  deps: AuthHealthcheckDeps,
): Promise<AuthHealthcheckResult> {
  const dir = await mkdtemp(join(tmpdir(), 'silithid-healthcheck-'))
  try {
    await deps.adapter.createSession({
      roleKey: 'majordome',
      systemPrompt: 'healthcheck',
      cwd: dir,
      tools: { bash: false, fs: 'none', mcp: [] },
      onEvent: () => {},
    })
    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await raiseAlert(deps, error)
    return { ok: false, error }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function raiseAlert(deps: AuthHealthcheckDeps, error: string): Promise<void> {
  const existing = await deps.db
    .selectFrom('inbox_items')
    .select('id')
    .where('type', '=', 'alert')
    .where('status', '=', 'open')
    .where(({ eb, ref }) => eb(ref('payload', '->>').key('cause'), '=', ALERT_KEY))
    .executeTakeFirst()

  if (existing) return

  await deps.db
    .insertInto('inbox_items')
    .values({
      type: 'alert',
      title: "Authentification agent indisponible",
      payload: JSON.stringify({ cause: ALERT_KEY, error }),
      archive_to_client: false,
    })
    .execute()

  await deps.mailer.send({
    to: deps.alertTo,
    subject: '[silithid] Authentification agent indisponible',
    text: [
      "Le healthcheck n'a pas pu ouvrir de session agent.",
      '',
      `Erreur : ${error}`,
      '',
      "Tant que ce n'est pas résolu, aucune boucle ne peut avancer.",
    ].join('\n'),
  })
}
```

- [ ] **Step 6 : exposer la route et relancer**

`apps/server/src/api/routes/health.ts` (remplace) :

```ts
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '../../db/types'
import { runAuthHealthcheck } from '../../health/auth-check'
import type { Mailer } from '../../integrations/mailer'
import type { RuntimeAdapter } from '../../runtime/types'

export interface HealthDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  mailer: Mailer
  alertTo: string
}

export async function healthRoutes(app: FastifyInstance, deps: HealthDeps): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok', at: new Date().toISOString() }))

  app.get('/api/health/auth', { preHandler: app.requireAuth }, async () =>
    runAuthHealthcheck(deps),
  )
}
```

Dans `app.ts`, construire l'adapter et le mailer, puis passer les dépendances :

```ts
const adapter = await createRuntimeAdapter(env)
const mailer = createMailer(env)
await app.register(healthRoutes, {
  db: deps.db,
  adapter,
  mailer,
  alertTo: env.ALERT_EMAIL_TO ?? 'alerts@exemple.test',
})
```

> `RUNTIME_ADAPTER=fake` est déjà forcé dans `vitest.config.ts` (Task 3) : `buildApp` n'importe donc jamais le SDK en test, et la suite ne consomme aucun token. Si un test échoue ici avec une erreur d'import du SDK, c'est que ce réglage a été perdu.

```bash
pnpm test && pnpm typecheck
```

Attendu : toute la suite passe.

- [ ] **Step 7 : commit**

```bash
git add -A && git commit -m "feat(health): healthcheck du runtime agent avec alerte inbox et email"
```

---

## Task 12 : Intégration continue

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1 : écrire le workflow**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: silithid_test
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      NODE_ENV: test
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/silithid_test
      DATABASE_URL_TEST: postgres://postgres:postgres@localhost:5432/silithid_test
      # Clés factices : la CI ne déchiffre aucune donnée réelle.
      MASTER_KEY: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
      SESSION_SECRET: BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=
      RUNTIME_ADAPTER: fake
      MAIL_DRY_RUN: 1
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: corepack enable pnpm
      - uses: actions/cache@v4
        with:
          path: ~/.local/share/pnpm/store
          key: pnpm-${{ hashFiles('pnpm-lock.yaml') }}
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

> La CI n'exécute jamais le `ClaudeAdapter` (`RUNTIME_ADAPTER=fake`) : aucun token n'est consommé, aucun secret réel n'est requis.

- [ ] **Step 2 : vérifier localement que les trois commandes passent**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

- [ ] **Step 3 : commit**

```bash
git add -A && git commit -m "ci: lint, typecheck et tests sur postgres 16"
```

---

## Task 13 : Front — écran de connexion

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/{main.tsx,App.tsx}`, `apps/web/src/lib/api.ts`, `apps/web/src/routes/Login.tsx`, `apps/web/src/styles/tokens.css`

L'objectif est de fermer la boucle « se connecter dans un navigateur », pas de livrer la DA. Les tokens CSS sont des **placeholders explicitement marqués**, à remplacer par le kit Claude Design quand il sera fourni.

- [ ] **Step 1 : créer le workspace web**

```bash
mkdir -p apps/web/src/{lib,routes,styles} && pnpm --filter @silithid/web add react react-dom && pnpm --filter @silithid/web add -D @vitejs/plugin-react vite @types/react @types/react-dom
```

`apps/web/package.json` :

```json
{
  "name": "@silithid/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

`apps/web/tsconfig.json` :

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`apps/web/vite.config.ts` :

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Le front parle à l'API du serveur Fastify en dev.
    proxy: { '/api': 'http://localhost:3000' },
  },
})
```

`apps/web/index.html` :

```html
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>silithid</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2 : écrire les tokens (placeholders)**

`apps/web/src/styles/tokens.css` :

```css
/*
 * PLACEHOLDER — à remplacer intégralement par le kit DA Claude Design.
 * Ne pas construire de composant qui dépende de ces valeurs précises :
 * seuls les NOMS de variables sont censés survivre au remplacement.
 */
:root {
  --hm-bg: #0d0f12;
  --hm-surface: rgba(255, 255, 255, 0.06);
  --hm-border: rgba(255, 255, 255, 0.12);
  --hm-text: #e8eaed;
  --hm-text-muted: #9aa0a6;
  --hm-accent: #c96442;
  --hm-danger: #d9534f;
  --hm-radius: 12px;
  --hm-space: 8px;
  --hm-font: ui-sans-serif, system-ui, -apple-system, sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--hm-bg);
  color: var(--hm-text);
  font-family: var(--hm-font);
}
```

- [ ] **Step 3 : écrire le client API et l'écran**

`apps/web/src/lib/api.ts` :

```ts
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, payload.error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export interface Me {
  id: string
  login: string
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  login: (login: string, password: string) =>
    request<Me>('POST', '/api/auth/login', { login, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
}
```

`apps/web/src/routes/Login.tsx` :

```tsx
import { type FormEvent, useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { Me } from '../lib/api'

export function Login({ onSuccess }: { onSuccess: (me: Me) => void }) {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      onSuccess(await api.login(login, password))
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Identifiants invalides.'
          : 'Connexion impossible.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: '15vh auto', display: 'grid', gap: 12 }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>silithid</h1>
      <input
        aria-label="Identifiant"
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        autoComplete="username"
        placeholder="Identifiant"
      />
      <input
        aria-label="Mot de passe"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        placeholder="Mot de passe"
      />
      <button type="submit" disabled={pending || !login || !password}>
        {pending ? 'Connexion…' : 'Se connecter'}
      </button>
      {error && <p style={{ color: 'var(--hm-danger)', margin: 0 }}>{error}</p>}
    </form>
  )
}
```

`apps/web/src/App.tsx` :

```tsx
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import type { Me } from './lib/api'
import { Login } from './routes/Login'

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setChecked(true))
  }, [])

  if (!checked) return null
  if (!me) return <Login onSuccess={setMe} />

  return (
    <main style={{ padding: 24 }}>
      <p>Connecté en tant que {me.login}.</p>
      <button
        type="button"
        onClick={() => {
          void api.logout().then(() => setMe(null))
        }}
      >
        Se déconnecter
      </button>
    </main>
  )
}
```

`apps/web/src/main.tsx` :

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/tokens.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 4 : créer l'utilisateur local**

Le script `apps/server/scripts/create-user.ts` a été créé à la Task 7 :

```bash
pnpm --filter @silithid/server exec tsx scripts/create-user.ts florian <mot-de-passe>
```

> **N'utilise pas `tsx -e "…"`** pour ça : `tsx` compile le code passé en `-e` au format CJS, qui refuse le `await` de premier niveau — la commande échoue avec `Top-level await is currently not supported with the "cjs" output format`. D'où un vrai fichier de script.

- [ ] **Step 5 : vérifier de bout en bout dans le navigateur**

Deux terminaux :

```bash
pnpm dev
```

```bash
pnpm dev:web
```

Ouvrir `http://localhost:5173`. Attendu : l'écran de connexion s'affiche ; un mauvais mot de passe affiche « Identifiants invalides » ; le bon affiche « Connecté en tant que florian » ; un rechargement de page garde la session ; « Se déconnecter » ramène à l'écran de connexion.

- [ ] **Step 6 : commit**

```bash
git add -A && git commit -m "feat(web): écran de connexion React + tokens DA placeholder"
```

---

## État à la fin de la Phase 1 (vérifié le 2026-08-12)

Contrôle d'acceptation réalisé depuis un état vierge (`dropdb` des deux bases, puis `./scripts/setup.sh`) :

| Vérification | Résultat |
|---|---|
| `./scripts/setup.sh` sur base vierge | 14 tables migrées, 6 templates de rôle seedés |
| `pnpm test` | 43 tests, 9 fichiers |
| `pnpm lint` / `pnpm typecheck` | propres (server + web + shared) |
| Serveur + login HTTP | `/api/health` 200, login 200, cookie `httpOnly` |
| Écran de connexion | vérifié au navigateur, session conservée au rechargement |
| Agent réel en worktree jetable | fichier écrit, 611 tokens |
| Healthcheck runtime | `ok:true` en ~5 s ; runtime injoignable → `ok:false` borné à 30 s |

Trois ajouts non prévus par le plan initial, tous nés d'un défaut constaté à l'exécution :

- `RuntimeAdapter.healthcheck()` — `createSession` ne fait aucun appel réseau côté Claude, le healthcheck ne pouvait donc rien détecter.
- Un délai maximal sur le healthcheck — sans lui, un runtime injoignable faisait pendre l'appel indéfiniment.
- `apps/server/scripts/create-user.ts` — `tsx -e` compile en CJS et refuse le `await` de premier niveau.

Deux corrections de fragilité : altération déterministe du chiffré dans le test crypto, et `env.test.ts` qui vérifiait un nom de base au lieu d'un comportement.

## Critère de fin de Phase 1

La phase est terminée quand, sur une machine ayant seulement Node 22, Postgres 16 et git :

```bash
./scripts/setup.sh && pnpm test && pnpm dev
```

produit une base migrée et seedée, une suite de tests verte, un serveur qui répond, un écran de connexion fonctionnel — et que `pnpm --filter @silithid/server exec tsx scripts/smoke-agent.ts` fait écrire un fichier par un agent réel dans un worktree jetable.

Cela couvre les critères J1 et J2 du brief, à une substitution près : `docker compose up` → `./scripts/setup.sh`.

## Ce qui n'est délibérément pas dans cette phase

À ne pas anticiper, même si l'occasion se présente :

- **pg-boss et la planification** (le cron 15 min du healthcheck) → Phase 2 (J3)
- **Machine à états, worktrees rattachés à un vrai dépôt, bus de messages** → Phase 2 (J3)
- **SSE `/api/events`** → Phase 3 (J6)
- **Toute route inbox, projet, step, run** → Phases 2 et 3
- **Les tokens DA réels** → à l'arrivée du kit Claude Design
- **`usage()` réel** → J12, si et seulement si une source de données existe

## Deux constats de la Task 10 qui portent au-delà de la Phase 1

**1. `allowedTools` n'est pas une frontière de sécurité — `tools` l'est.**

Découvert empiriquement pendant le smoke test, pas en lisant les types : avec une `ToolPolicy` à `bash: false`, l'agent a quand même appelé `Bash` avec succès. `options.allowedTools` **dispense les outils listés du prompt de permission** ; il ne retire rien de la surface disponible, qui reste par défaut l'ensemble des outils Claude Code. Pour qu'un outil soit réellement hors de portée, il faut le retirer de `options.tools`.

Le `ClaudeAdapter` passe donc les deux : `tools` (surface réelle) et `allowedTools` (dispense de prompt).

**Conséquence directe sur la DoD §14** (« les 3 gates structurels infranchissables même en mode auto ») : le test dédié qui vérifiera ces gates doit prouver qu'un rôle **ne peut pas** appeler un outil hors politique, pas seulement qu'il ne le fait pas spontanément. Concrètement, à écrire en Phase 2 :
- le communicant avec `mcp: ['gmail_draft']` ne doit pas pouvoir envoyer, seulement créer un brouillon ;
- le juge avec `fs: 'read'` ne doit pas pouvoir écrire ;
- le garant avec `bash: false` ne doit pas pouvoir exécuter de commande.

Un test qui se contente d'observer le comportement passerait alors même que la barrière est absente.

**2. La consommation 5 h / 7 j existe, mais seulement en flux.**

Le SDK n'expose aucune fonction interrogeable à froid, mais il pousse un `SDKRateLimitEvent` **pendant** une session : `rate_limit_info: { rateLimitType: 'five_hour' | 'seven_day' | …, utilization?: number, resetsAt?: number }`.

C'est la réponse à la question ouverte sur `usage()`, et elle change l'option retenue pour J12 : plutôt que d'abandonner le gating ou de cumuler les `cost_tokens` à la main, **capter `rate_limit_event` pendant les `send()` et mémoriser la dernière utilisation vue par fenêtre** (dans `usage_windows`, table déjà prévue). `usage()` renvoie alors la dernière mesure connue avec son horodatage, et `available: false` tant qu'aucune session n'a encore tourné.

Cette approche a une limite à assumer : la mesure est fraîche seulement si des runs ont eu lieu récemment. Après une longue période d'inactivité, le scheduler repart d'une information périmée — d'où l'intérêt de dater la mesure et de la considérer comme non disponible au-delà d'un certain âge.

## Points ouverts à trancher avant la Phase 2
2. **Kit DA Claude Design** : les prototypes et tokens mentionnés au §12 du brief n'existent pas encore dans le dépôt. Ils deviennent bloquants à J7 (inbox UI), pas avant.
3. **Dépôt pilote** : à nommer avant la Task 4 de la Phase 2 (J4, première PR réelle).

# Chapo — Phase 2 (J3–J5) : Moteur de boucles

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire tourner une boucle interne réelle : le garant cadre un step via une sortie structurée, le dev implémente dans un worktree git rattaché à un vrai dépôt et ouvre une PR, le reviewer vérifie et renvoie au dev jusqu'à convergence (borné à 3), le tout piloté par une machine à états pure, exécuté par des jobs pg-boss, et intégralement tracé dans `messages`.

**Architecture:** La machine à états est une **fonction pure** dans `src/domain` : elle prend `(état, événement, contexte)` et rend une décision. Elle ne touche ni la base, ni le SDK, ni git — donc elle est testable exhaustivement sans infrastructure. Un worker pg-boss `run.step` fait avancer un run **d'une seule transition** par exécution puis se ré-enfile : chaque pas est ainsi retryable et une panne ne perd qu'un pas. Les effets de bord (écrire un `message`, créer un item d'inbox, incrémenter l'itération) sont décrits par la décision et appliqués par l'orchestrateur, jamais par le domaine.

**Tech Stack:** ajouts à la Phase 1 — pg-boss · `@octokit/rest` (ou `gh` en CLI) · `simple-git` ou `execFile('git')` · zod (déjà présent) · SDK MCP tool pour la sortie structurée du garant

---

## État à l'entrée (vérifié le 2026-08-12)

Phase 1 livrée, 43 tests verts, projet renommé `chapo`. Disponible et à réutiliser :

| Brique | Où | À savoir |
|---|---|---|
| `RuntimeAdapter` + `FakeAdapter` + `ClaudeAdapter` | `src/runtime/` | `FakeAdapter` accepte `replies[]` et `healthcheckError` |
| Runner de migrations | `src/db/migrate.ts` | déposer `0002_*.sql`, il est joué par ordre alphabétique |
| Types Kysely | `src/db/types.ts` | à étendre pour toute nouvelle table/colonne |
| Chiffrement, settings, auth, mailer | `src/crypto`, `src/settings`, `src/auth`, `src/integrations/mailer.ts` | — |
| Worktree jetable | `src/runtime/worktree.ts` | `createThrowawayRepo()` — dépôt vide en `/tmp`, à **compléter**, pas à remplacer |
| Tests | `apps/server/tests/` | Postgres réel, `drop schema public cascade` en `beforeAll`, `fileParallelism: false` |

**Conventions à respecter** (établies en Phase 1, ne pas re-débattre) : ESM sans extension `.js` dans les imports · pas d'étape de build (`tsx`) · Biome (`pnpm lint:fix`) · commentaires en français, seulement quand ils expliquent un *pourquoi* · TDD sur toute logique.

---

## Contrats v0.3 à honorer dans cette phase

Le garant a figé six contrats après la Phase 1. Trois sont à implémenter ici, trois sont à respecter sans être implémentés maintenant.

### À implémenter

**1. `healthcheck()` renvoie `{ ok: boolean; latencyMs: number }`.** Aujourd'hui il renvoie `{ ok, error? }`. Le nouveau contrat impose `latencyMs`. **Conserver `error?`** : sans lui, l'alerte d'inbox et l'email n'ont plus de cause à afficher, ce que le brief exige par ailleurs (« si invalide : inbox `alert` + email SMTP immédiat »). Forme finale : `{ ok: boolean; latencyMs: number; error?: string }`.

**2. `tools` est la frontière de sécurité, pas `allowedTools`.** Constat de Phase 1 : un agent a appelé `Bash` malgré `bash: false`. La `ToolPolicy` doit se traduire en une restriction *effective*, vérifiée par un test qui prouve l'**impossibilité**. Ce test est le premier des trois gates de la DoD §14.

**3. Sortie structurée du garant, forme `frame`.** Le garant n'émet jamais de texte libre vers la machine à états. Il appelle un outil dont la charge est validée par zod :

```ts
frame: {
  dev_prompt: string
  acceptance_criteria: string[]
  pages_to_judge: string[]
}
```

Texte libre en sortie ⇒ retry avec rappel du format. La forme `verdict` est figée mais implémentée en Phase 4 (J9) — **ne pas l'anticiper au-delà du type**.

### À respecter sans implémenter

**4. `usage()` est événementiel.** La conso n'arrive que via `SDKRateLimitEvent` pendant les `send()`. Cette phase **capte et stocke** la mesure (c'est dans `send()`, donc ici) ; la règle de péremption 90 min, la jauge « inconnu » et la majoration de 10 points appartiennent au scheduler (J12).

**5. Aucun test ne consomme de tokens.** `RUNTIME_ADAPTER=fake` en CI. Les tâches qui appellent un vrai modèle ont une vérification manuelle scriptée, jamais un test automatisé.

**6. Les 3 gates structurels sont infranchissables.** Le gate email et le gate prod arrivent en Phases 4 et 5. Le gate outillage arrive ici (contrat 2).

---

## Décisions de conception à acter

Trois points que le brief ne tranche pas et qu'il faut trancher avant d'écrire le code. Je propose, et le plan les applique.

**A. Que se passe-t-il quand la boucle dev↔reviewer épuise ses 3 allers-retours ?** Le brief borne la boucle sans dire ce qui suit. → **inbox `alert` + `awaiting_human`.** Pas `failed` : le travail du dev existe, la PR est ouverte, un humain peut trancher. Pas `verdict` non plus : le garant n'a pas de rapport de juge à ce stade, il arbitrerait à l'aveugle.

**B. Comment un run reprend-il après une pause ou une question bloquante ?** Il faut mémoriser où reprendre. → une colonne **`runs.resume_state`**, écrite à l'entrée en `awaiting_human` ou `paused_budget`, lue et effacée à la reprise. Une seule colonne couvre les deux cas.

**C. Où vivent les dépôts clonés ?** → `WORKTREES_ROOT/<project-slug>/repo` (clone unique par projet, réutilisé) et `WORKTREES_ROOT/<project-slug>/runs/<run-id>` (worktree par run). Branche `run/<run-id>` — le préfixe `run/*` est ce que le workflow de staging écoute (brief §10).

---

## Structure de fichiers

```
apps/server/src/
├── db/migrations/0002_globes_and_resume.sql   # globes, projects.globe_id, runs.resume_state
├── domain/
│   ├── run-state.ts        # machine à états PURE : decide(state, event, ctx) → Decision
│   └── run-state.test.ts   # (dans tests/) exhaustif, sans DB
├── loop/
│   ├── orchestrator.ts     # applique une Decision : DB + effets + ré-enfilage
│   ├── bus.ts              # écriture/lecture des `messages` (audit)
│   ├── roles.ts            # résout le rôle d'un projet (roles → role_templates)
│   └── steps/
│       ├── framing.ts      # garant → frame
│       ├── coding.ts       # dev → commits + PR
│       └── reviewing.ts    # reviewer → OK/KO
├── git/
│   ├── repo.ts             # clone/fetch du miroir projet
│   └── worktree.ts         # add/remove d'un worktree par run
├── integrations/github.ts  # PR : create, get checks
├── jobs/
│   ├── boss.ts             # démarrage pg-boss, enregistrement des workers
│   └── run-step.ts         # worker `run.step`
└── runtime/
    ├── tools.ts            # ToolPolicy → restriction EFFECTIVE (frontière de sécurité)
    └── structured.ts       # outil de sortie structurée + validation zod + retry
```

---

## Task 1 — Migration 0002 : globes, `globe_id`, `resume_state`

**Mécanique : exécution directe autorisée.**

**Files:** Create `apps/server/src/db/migrations/0002_globes_and_resume.sql` · Modify `src/db/types.ts` · Modify `src/db/seed.ts` · Test `tests/globes.test.ts`

- [ ] **Step 1 : écrire la migration**

```sql
-- Globes : espaces de conscience au-dessus des projets (Desura / Perso / R&D).
create table globes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  color text,                       -- teinte du globe dans le système solaire
  position int not null default 0,
  created_at timestamptz not null default now()
);

-- Un globe « Desura » est créé au setup : projects.globe_id est NOT NULL, il
-- faut donc une valeur avant d'ajouter la contrainte.
insert into globes (name, slug, position) values ('Desura', 'desura', 0);

alter table projects add column globe_id uuid references globes(id);
update projects set globe_id = (select id from globes where slug = 'desura');
alter table projects alter column globe_id set not null;
create index projects_globe_idx on projects (globe_id);

-- Où reprendre après une pause budget ou une question bloquante. Une seule
-- colonne couvre les deux cas : on n'est jamais en pause et bloqué à la fois.
alter table runs add column resume_state text;

-- Nombre d'allers-retours dev↔reviewer déjà consommés dans cette itération.
alter table runs add column review_round int not null default 0;
```

- [ ] **Step 2 : étendre `src/db/types.ts`** — table `globes`, colonnes `projects.globe_id`, `runs.resume_state`, `runs.review_round`. Suivre le style existant (`Generated<>`, `Timestamp`).

- [ ] **Step 3 : test** — `tests/globes.test.ts` : le globe `desura` existe après migration ; insérer un projet sans `globe_id` échoue ; avec un `globe_id` valide réussit.

- [ ] **Step 4** `pnpm test && pnpm lint && pnpm typecheck` puis `pnpm db:reset` pour valider la migration sur base neuve.

- [ ] **Step 5** commit : `feat(db): globes, globe_id sur projects, resume_state sur runs`

---

## Task 2 — `ToolPolicy` devient une frontière de sécurité réelle

**Subagent obligatoire** (sécurité).

**Files:** Create `src/runtime/tools.ts` · Modify `src/runtime/claude.ts` · Test `tests/tool-policy.test.ts` · Create `apps/server/scripts/smoke-tool-gate.ts`

- [ ] **Step 1 : établir les faits avant d'écrire.** Lire `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` et identifier **quelle option restreint réellement la surface d'outils** (`tools`, `disallowedTools`, `permissionMode`, un hook `canUseTool`…). `allowedTools` ne le fait pas — c'est établi. **Écrire les faits trouvés en commentaire en tête de `tools.ts`**, avec les noms exacts des options. Si aucune option ne restreint réellement, le dire et s'arrêter (statut BLOCKED) : la sécurité ne se bricole pas.

- [ ] **Step 2 : écrire le test qui échoue** — `tests/tool-policy.test.ts`, sur la traduction pure :

```ts
import { expect, test } from 'vitest'
import { resolveToolPolicy } from '../src/runtime/tools'

test('fs: none n autorise aucun outil de fichier', () => {
  const r = resolveToolPolicy({ bash: false, fs: 'none', mcp: [] })
  expect(r.allowed).not.toContain('Read')
  expect(r.allowed).not.toContain('Write')
  expect(r.allowed).not.toContain('Bash')
})

test('fs: read autorise la lecture, jamais l ecriture', () => {
  const r = resolveToolPolicy({ bash: false, fs: 'read', mcp: [] })
  expect(r.allowed).toContain('Read')
  expect(r.allowed).not.toContain('Write')
  expect(r.allowed).not.toContain('Edit')
})

test('bash: false exclut Bash de la surface, pas seulement de l allowlist', () => {
  const r = resolveToolPolicy({ bash: true, fs: 'write', mcp: [] })
  expect(r.allowed).toContain('Bash')
  const denied = resolveToolPolicy({ bash: false, fs: 'write', mcp: [] })
  expect(denied.allowed).not.toContain('Bash')
  // Le champ que le SDK utilise réellement pour restreindre doit refléter la
  // politique — nom exact à confirmer au Step 1.
  expect(denied.sdkOptions).toMatchObject({ /* champ restrictif */ })
})

test('les outils MCP sont prefixes et limites a l allowlist', () => {
  const r = resolveToolPolicy({ bash: false, fs: 'none', mcp: ['client_kb'] })
  expect(r.allowed.some((t) => t.includes('client_kb'))).toBe(true)
  expect(r.allowed.some((t) => t.includes('gmail'))).toBe(false)
})
```

- [ ] **Step 3 : implémenter `resolveToolPolicy`** — une fonction pure `ToolPolicy → { allowed: string[]; sdkOptions: object }`. `claude.ts` ne construit plus ses options à la main : il appelle cette fonction.

- [ ] **Step 4 : la preuve d'impossibilité.** `scripts/smoke-tool-gate.ts` : un agent avec `{ bash: false, fs: 'read', mcp: [] }` dans un worktree jetable, à qui on demande explicitement d'exécuter `echo compromis > /tmp/chapo-gate-breach` **et** d'écrire un fichier. Le script réussit si le fichier de brèche n'existe pas **et** qu'aucun `tool_use` de type `Bash`/`Write` n'a été observé. Vérification manuelle (consomme des tokens), à lancer et à rapporter.

- [ ] **Step 5** `pnpm test && pnpm lint && pnpm typecheck`, lancer le smoke, commit : `feat(runtime): ToolPolicy comme frontiere de securite effective`

---

## Task 3 — `healthcheck` amendé + capture de la conso

**Mécanique : exécution directe autorisée.**

**Files:** Modify `src/runtime/types.ts`, `fake.ts`, `claude.ts`, `src/health/auth-check.ts`, `tests/auth-check.test.ts`

- [ ] **Step 1** `HealthcheckResult` devient `{ ok: boolean; latencyMs: number; error?: string }`. Mesurer avec `Date.now()` de part et d'autre de l'échange, dans les deux adapters. Le `FakeAdapter` renvoie `latencyMs: 0`.

- [ ] **Step 2** Dans `claude.ts`, pendant l'itération du flux de `send()` : repérer l'événement de limite de débit (nom exact à confirmer dans `sdk.d.ts` — cherché `RateLimit`), en extraire `{ windowKind, usedPct }` et le mémoriser dans l'adapter. `usage()` renvoie la dernière mesure vue avec sa date. **Ne pas** implémenter la péremption ni la majoration : c'est J12.

`UsageSnapshot` devient :

```ts
export interface UsageSnapshot {
  fiveHourPct: number
  sevenDayPct: number
  available: boolean
  /** Date de la dernière mesure observée. `undefined` si jamais mesuré. */
  sampledAt?: Date
}
```

- [ ] **Step 3** Adapter les tests existants (`latencyMs` présent, `sampledAt` absent tant qu'aucun `send()` n'a eu lieu). `pnpm test` doit repasser à vert.

- [ ] **Step 4** commit : `feat(runtime): healthcheck avec latence + capture evenementielle de la conso`

---

## Task 4 — Machine à états pure

**Subagent obligatoire** (machine à états). **TDD strict, exhaustif.**

**Files:** Create `src/domain/run-state.ts` · Test `tests/run-state.test.ts`

Aucune dépendance : ni Kysely, ni le SDK, ni `node:fs`. Si le fichier importe quoi que ce soit d'autre que des types de `@chapo/shared`, c'est un défaut.

- [ ] **Step 1 : écrire les types**

```ts
import type { AutonomyMode, InboxType, RunState } from '@chapo/shared'

export type LoopEvent =
  | { type: 'frame_ready' }
  | { type: 'pr_opened'; prNumber: number }
  | { type: 'review_ok' }
  | { type: 'review_ko' }
  | { type: 'ci_green' }
  | { type: 'ci_red'; reason: string }
  | { type: 'judge_report' }
  | { type: 'verdict_conforme' }
  | { type: 'verdict_ecarts' }
  | { type: 'question'; blocking: boolean }
  | { type: 'human_resolved' }
  | { type: 'budget_pause' }
  | { type: 'budget_resume' }
  | { type: 'aborted'; reason: string }

export interface RunContext {
  iteration: number
  maxIterations: number
  reviewRound: number
  /** Borne dure des allers-retours dev↔reviewer. Brief §7 : 3. */
  maxReviewRounds: number
  autonomy: AutonomyMode
  /** État à restaurer en sortie de `awaiting_human` / `paused_budget`. */
  resumeState?: RunState
}

export type Effect =
  | { type: 'open_inbox_item'; itemType: InboxType; subtype?: string; reason: string }
  | { type: 'increment_iteration' }
  | { type: 'increment_review_round' }
  | { type: 'reset_review_round' }
  | { type: 'remember_resume_state'; state: RunState }
  | { type: 'clear_resume_state' }
  | { type: 'end_run'; outcome: 'done' | 'failed' }

export type Decision =
  | { kind: 'transition'; to: RunState; effects: Effect[] }
  | { kind: 'stay'; effects: Effect[] }
  | { kind: 'invalid'; reason: string }

export function decide(state: RunState, event: LoopEvent, ctx: RunContext): Decision
```

- [ ] **Step 2 : écrire les tests avant l'implémentation.** Couvrir au minimum, avec un test nommé par règle :

| Depuis | Événement | Attendu |
|---|---|---|
| `framing` | `frame_ready` | → `coding` |
| `coding` | `pr_opened` | → `reviewing` |
| `reviewing` | `review_ok` | → `deploying`, `reset_review_round` |
| `reviewing` | `review_ko`, round 0/3 | → `coding`, `increment_review_round` |
| `reviewing` | `review_ko`, round 2/3 | → `awaiting_human` + inbox `alert` + `remember_resume_state` (décision A) |
| `deploying` | `ci_green` | → `judging` |
| `deploying` | `ci_red` | → `awaiting_human` + inbox `alert` |
| `judging` | `judge_report` | → `verdict` |
| `verdict` | `verdict_conforme`, `gated` | → `awaiting_human` + inbox `approval:step_end` |
| `verdict` | `verdict_conforme`, `auto` | → `done` + `end_run` |
| `verdict` | `verdict_ecarts`, iter 1/4 | → `framing`, `increment_iteration`, `reset_review_round` |
| `verdict` | `verdict_ecarts`, iter 4/4 | → `failed` + inbox `alert` + `end_run` |
| n'importe quel état actif | `question` bloquante | → `awaiting_human` + `remember_resume_state` |
| n'importe quel état actif | `question` non bloquante | `stay` + inbox `question` (la boucle continue) |
| `awaiting_human` | `human_resolved` | → `ctx.resumeState`, `clear_resume_state` |
| n'importe quel état actif | `budget_pause` | → `paused_budget` + `remember_resume_state` |
| `paused_budget` | `budget_resume` | → `ctx.resumeState` |
| `done` / `failed` | tout événement | `invalid` |
| `awaiting_human` | `frame_ready` | `invalid` |

Trois tests transverses, plus importants que les cas nominaux :

```ts
test('aucun evenement ne fait sortir d un etat terminal', () => {
  for (const state of ['done', 'failed'] as const) {
    for (const event of ALL_EVENTS) {
      expect(decide(state, event, baseCtx()).kind).toBe('invalid')
    }
  }
})

test('le gate step_end ne saute JAMAIS hors mode auto', () => {
  const d = decide('verdict', { type: 'verdict_conforme' }, baseCtx({ autonomy: 'gated' }))
  expect(d).toMatchObject({ kind: 'transition', to: 'awaiting_human' })
  expect(d.effects).toEqual(
    expect.arrayContaining([expect.objectContaining({ subtype: 'step_end' })]),
  )
})

test('une transition invalide ne produit jamais d effet', () => {
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      const d = decide(state, event, baseCtx())
      if (d.kind === 'invalid') expect(d).not.toHaveProperty('effects')
    }
  }
})
```

- [ ] **Step 3** Vérifier l'échec, implémenter, `pnpm test`, commit : `feat(domain): machine a etats pure d une boucle`

---

## Task 5 — Bus de messages

**Mécanique : exécution directe autorisée.**

**Files:** Create `src/loop/bus.ts` · Test `tests/bus.test.ts`

- [ ] **Step 1** `appendMessage(db, { runId, fromRole, toRole, kind, body, meta })` et `readRunMessages(db, runId)` (ordre chronologique). `kind` ∈ `prompt|report|question|correction|info`, typé depuis `@chapo/shared` — l'ajouter là-bas s'il n'y est pas.

- [ ] **Step 2** Tests : ordre chronologique préservé ; `meta` fait l'aller-retour JSON ; un `runId` inexistant est refusé par la contrainte de clé étrangère.

- [ ] **Step 3** commit : `feat(loop): bus de messages inter-agents persiste`

---

## Task 6 — Dépôt et worktrees git

**Subagent obligatoire** (moteur de boucles).

**Files:** Create `src/git/repo.ts`, `src/git/worktree.ts` · Modify `src/runtime/worktree.ts` (garder `createThrowawayRepo`) · Test `tests/git-worktree.test.ts`

- [ ] **Step 1 : tests d'abord**, contre un **dépôt local créé dans le test** (aucun accès réseau, aucun dépôt GitHub) :

- `ensureProjectRepo` clone une première fois, puis réutilise le clone existant (deuxième appel : pas de nouveau clone, et un `fetch`).
- `addRunWorktree(repoPath, runId)` crée un worktree sur une branche neuve `run/<runId>`, à partir de la branche par défaut.
- Deux worktrees de deux runs coexistent sans se marcher dessus (fichiers indépendants).
- `removeRunWorktree` supprime le worktree et le répertoire, et un second appel ne lève pas.
- Un worktree dont le répertoire a été supprimé à la main est récupérable (`git worktree prune`) — c'est le cas réel après un crash.

- [ ] **Step 2 : implémenter** avec `execFile('git', [...])` (jamais `exec` avec une chaîne : les noms de branche viennent de la base). Chemins selon la décision C.

- [ ] **Step 3** commit : `feat(git): clone par projet et worktree par run`

---

## Task 7 — Sortie structurée du garant

**Subagent obligatoire** (prompts de rôles + contrat).

**Files:** Create `src/runtime/structured.ts` · Modify `src/db/seeds/role_templates/garant.md` · Test `tests/structured.test.ts`

- [ ] **Step 1 : établir comment on donne un outil à un agent.** Lire `sdk.d.ts` : chercher de quoi déclarer un outil in-process (`createSdkMcpServer`, `tool()`, `mcpServers`…). **Noter les noms exacts trouvés en commentaire.** Si le SDK ne permet pas de définir un outil custom, s'arrêter (BLOCKED) et le dire : le contrat du garant en dépend.

- [ ] **Step 2 : schéma zod**

```ts
import { z } from 'zod'

export const frameSchema = z.object({
  dev_prompt: z.string().min(50),
  acceptance_criteria: z.array(z.string().min(5)).min(1),
  pages_to_judge: z.array(z.string()),
})
export type Frame = z.infer<typeof frameSchema>

/** Figé par le garant, implémenté en Phase 4 (J9). Type seulement. */
export const verdictSchema = z.object({
  decision: z.enum(['conforme', 'ecarts']),
  ecarts: z.array(
    z.object({
      severite: z.enum(['bloquant', 'majeur', 'mineur']),
      description: z.string(),
      correctif: z.string(),
    }),
  ),
  dev_prompt_correctif: z.string().optional(),
})
```

- [ ] **Step 3 : la boucle de retry.** `collectStructured(adapter, session, prompt, schema, { maxAttempts: 3 })` : si l'agent répond du texte libre au lieu d'appeler l'outil, ou si la charge ne valide pas, relancer en rappelant le format et en citant l'erreur zod. Après `maxAttempts`, lever. **Testable avec le `FakeAdapter`** : scripter une première réponse en texte libre puis une charge valide, et vérifier qu'il y a bien eu deux tentatives.

- [ ] **Step 4 : réécrire `garant.md`.** Le prompt actuel demande de la prose. Il doit : dire d'appeler l'outil de sortie structurée et jamais de répondre en texte libre ; recevoir `iteration` / `max_iterations` dans son préambule et savoir qu'à la dernière itération il arbitre ce qu'il sacrifie ; pouvoir poser une `question` bloquante ou non ; nommer explicitement les pages pour le juge. Garder « français, direct, pas de flatterie ».

- [ ] **Step 5** commit : `feat(runtime): sortie structuree validee par zod + prompt garant refondu`

---

## Task 8 — pg-boss et le worker `run.step`

**Subagent obligatoire** (moteur de boucles).

**Files:** Create `src/jobs/boss.ts`, `src/jobs/run-step.ts`, `src/loop/orchestrator.ts`, `src/loop/roles.ts` · Modify `src/index.ts` · Test `tests/orchestrator.test.ts`

- [ ] **Step 1** `pnpm --filter @chapo/server add pg-boss`

- [ ] **Step 2 : `orchestrator.ts`** — le seul endroit qui a le droit d'écrire l'état d'un run :

```ts
/**
 * Applique un événement à un run : lit son état et son contexte, demande la
 * décision au domaine, écrit l'état et les effets dans UNE transaction.
 *
 * Le domaine décide, l'orchestrateur applique. Aucune règle métier ici : si
 * une condition apparaît dans ce fichier, elle est au mauvais endroit.
 */
export async function applyEvent(
  db: Kysely<Database>,
  runId: string,
  event: LoopEvent,
): Promise<{ state: RunState; decision: Decision }>
```

Toute transition écrit un `message` (audit, brief §7). Une décision `invalid` n'écrit rien et lève.

- [ ] **Step 3 : tests de l'orchestrateur** avec Postgres réel : une transition écrit l'état **et** un `message` ; un effet `increment_iteration` incrémente réellement ; une décision `invalid` ne laisse **aucune** trace (vérifier l'atomicité en comptant les `messages` avant/après) ; `awaiting_human` écrit `resume_state`, et `human_resolved` le restaure puis l'efface.

- [ ] **Step 4 : le worker.** `run.step` fait avancer **un** pas puis se ré-enfile tant que le run est dans un état actif ; il ne se ré-enfile pas sur `awaiting_human`, `paused_budget`, `done`, `failed`. Idempotence : un job rejoué sur un run déjà avancé ne doit pas double-appliquer — la garde est l'état lu en début de transaction.

- [ ] **Step 5** Démarrer pg-boss dans `src/index.ts`, et **le déplacer aussi le healthcheck en cron 15 min** (brief §4) puisque l'infrastructure existe enfin.

- [ ] **Step 6** commit : `feat(jobs): pg-boss + worker run.step + orchestrateur transactionnel`

---

## Task 9 — Critère J3 : `framing → coding` factice tracé en base

**Subagent obligatoire** (moteur de boucles).

**Files:** Test `tests/loop-j3.test.ts` · Create `apps/server/scripts/smoke-loop-fake.ts`

- [ ] **Step 1** Un test d'intégration avec le `FakeAdapter` : créer globe → client → projet → step, démarrer un run, laisser le worker avancer, et vérifier en base que le run est passé `framing → coding`, que `messages` contient la passation garant→dev, et que le worktree a été créé puis nettoyé.

- [ ] **Step 2** `scripts/smoke-loop-fake.ts` : la même chose en ligne de commande, avec affichage de la timeline d'audit — c'est l'outil de diagnostic qu'on utilisera pendant tout le reste du sprint.

- [ ] **Step 3** commit : `test(loop): boucle framing->coding tracee de bout en bout (critere J3)`

---

## Task 10 — Critère J4 : garant + dev réels → PR ouverte

**Subagent obligatoire.**

**Files:** Create `src/integrations/github.ts`, `src/loop/steps/framing.ts`, `src/loop/steps/coding.ts` · Create `apps/server/scripts/smoke-loop-real.ts`

- [ ] **Step 1 : le dépôt de test.** Ne **pas** viser `desura/Desura.fr` tout de suite : créer un dépôt jetable (`desura/chapo-sandbox`) avec un README et un test qui passe. Le pilote réel arrive à J11 selon le brief.

- [ ] **Step 2 : GitHub.** PAT fine-grained en `settings` (chiffré via `setSecret`, jamais en clair — c'est déjà outillé). `createPullRequest`, `getPullRequest`, `listChecks`. Labels `chapo:run-<id>` (brief §10).

- [ ] **Step 3 : `framing.ts`** — charge le rôle garant du projet, injecte le préambule commun (contexte projet, specs du step, fiche client, `iteration`/`max_iterations`), appelle `collectStructured` avec `frameSchema`, écrit le `frame` dans un `message` `prompt` garant→dev, émet `frame_ready`.

- [ ] **Step 4 : `coding.ts`** — worktree du run, session dev avec `{ bash: true, fs: 'write', mcp: ['git','gh'] }`, envoie le `dev_prompt`, attend le rapport, ouvre la PR, émet `pr_opened`.

- [ ] **Step 5 : vérification manuelle** (`smoke-loop-real.ts`, consomme des tokens) : un step réel du dépôt sandbox produit une PR visible sur GitHub. Rapporter l'URL de la PR, le coût, et le contenu du `frame` produit.

- [ ] **Step 6** commit : `feat(loop): garant cadre et dev livre une PR reelle (critere J4)`

---

## Task 11 — Critère J5 : reviewer et boucle interne bornée

**Subagent obligatoire.**

**Files:** Create `src/loop/steps/reviewing.ts` · Modify `src/db/seeds/role_templates/reviewer.md` si nécessaire · Test `tests/review-loop.test.ts`

- [ ] **Step 1 : test de la borne avec le `FakeAdapter`** — un reviewer scripté pour répondre KO trois fois : le run doit finir en `awaiting_human` avec un item `alert`, **jamais** boucler indéfiniment. C'est le test qui compte le plus de cette tâche.

- [ ] **Step 2 : `reviewing.ts`** — worktree propre, checkout de la PR, session reviewer avec `{ bash: true, fs: 'read', mcp: ['git','gh'] }`. Sortie structurée `{ verdict: 'OK'|'KO', points: [{file, line?, action}] }` validée par zod — même mécanique que le garant, pas de texte libre.

- [ ] **Step 3 : vérification manuelle** : dev ↔ reviewer converge réellement sur le dépôt sandbox. Rapporter le nombre d'allers-retours et le coût.

- [ ] **Step 4** commit : `feat(loop): reviewer et boucle interne bornee a 3 (critere J5)`

---

## Critère de fin de Phase 2

```bash
pnpm test && pnpm lint && pnpm typecheck
pnpm --filter @chapo/server exec tsx scripts/smoke-loop-fake.ts   # sans token
pnpm --filter @chapo/server exec tsx scripts/smoke-loop-real.ts   # avec tokens
pnpm --filter @chapo/server exec tsx scripts/smoke-tool-gate.ts   # preuve du gate
```

Attendu : suite verte · une boucle complète tracée en base avec le `FakeAdapter` · sur le dépôt sandbox, un step réel produit une PR revue et convergée · un agent à qui on demande d'exécuter du shell alors que sa politique l'interdit **ne peut pas**.

## Hors périmètre de cette phase

Ne pas anticiper, même si l'occasion se présente : Playwright et le juge visuel (J8) · la forme `verdict` du garant au-delà du type (J9) · le communicant et Gmail (J10) · le staging et le gate prod (J11) · le scheduler de budget, la péremption 90 min et la majoration de 10 points (J12) · **toute l'UI** (Phase 3) · **toute la conscience collective** (hors sprint, voir le point ouvert ci-dessous).

## Points ouverts

1. **Conscience collective : contradiction à trancher.** `BRIEF-RETOUR.md` §6 la décrit comme centrale ; le brief v0.2 §2 l'exclut. Le brief fait foi, donc rien n'est implémenté — mais `Inbox.dc.html` contient vraisemblablement des items « validation · savoir » et un badge CONFLIT sans source de données. **À trancher avant J6.**
2. **Après 3 allers-retours dev↔reviewer** : décision A appliquée (`awaiting_human` + `alert`). À confirmer.
3. **Dépôt sandbox** : `desura/chapo-sandbox` à créer, ou nom au choix du garant.

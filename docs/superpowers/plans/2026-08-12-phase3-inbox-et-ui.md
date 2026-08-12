# Silithid — Phase 3 (J6–J7) : Inbox, SSE et première UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre la boucle pilotable par un humain. Backend d'inbox complet (6 types, résolution, reprise du run), flux SSE temps réel, puis les trois premiers écrans réels : Inbox, Dashboard, page Globes — avec le HiveStrip présent partout.

**Architecture:** L'inbox est le point de contact unique entre les boucles et l'humain (brief §1). Un item est créé par un `Effect` de la machine à états, jamais directement par un handler. Sa résolution ré-enfile le run via pg-boss — le même chemin que n'importe quelle autre transition, pas une voie parallèle. Le SSE diffuse un flux typé unique (`/api/events`) ; le front n'interroge jamais en boucle.

**Tech Stack:** ajouts — SSE natif Fastify · React 18 + TanStack Router/Query · les moteurs du pack DA importés tels quels (`tokens.css`, `ambiance.js`, `oscilloscope.js`, `logo-globe.js`, `orb.js`)

---

## Décision de périmètre actée le 12/08

Le pack Claude Design fait foi. Conséquence directe : **la conscience collective entre dans le produit**, alors que le brief v0.2 §2 l'excluait.

Elle n'entre **pas** dans cette phase. C'est un sous-système backend de l'ordre de grandeur du moteur de boucles (cascade projet → client → globe → Hive, pgvector, coffre à portées avec rotation, savoirs versionnés et révocables, outil MCP `memory` en écriture-par-proposition, `recalled_knowledge` dans les passations). Elle mérite sa propre phase et son propre calendrier.

**Ce que cette phase fait pour ne pas la bloquer :** l'inbox accepte dès maintenant le sous-type `savoir` sur les items de type `approval` (la colonne `subtype` existe déjà), et l'UI rend l'affordance. Les items ne seront simplement produits par personne tant que la phase conscience n'existe pas. C'est un branchement vide, pas une dette.

**Le calendrier J1→J14 du brief ne tient plus.** À refaire avec le garant : on en est à J5 sur 14 après trois phases, et le périmètre vient d'augmenter d'un sous-système entier.

---

## Ce que `data.js` révèle — quatre manques dans le schéma

`docs/design/data.js` est la fixture que consomment les prototypes : c'est le contrat que l'API doit honorer. Quatre champs qu'elle exige n'existent nulle part en base.

| Champ attendu | Où | Manque |
|---|---|---|
| `tint` | `PROJECTS[]` | Les projets ont une teinte propre (cluster de l'orbe, pastille de liste). Seul `globes.color` existe. → **`projects.tint text`** |
| `synth` | `PROJECTS[]` | Une ligne de synthèse (« Le dev itère sereinement · prod du step 3 à valider »). Elle est rédigée, pas calculée — c'est Hive qui la produit. → **`projects.synth text`**, écrite par Hive, jamais devinée par le front |
| `agent` | `INBOX[]` | Le rôle qui a levé l'item (« garant », « dev », « communicant », « boucle dev »). `inbox_items` n'a que `project_id` et `run_id`. → **`inbox_items.from_role text`** |
| `conso` en euros | `PROJECTS[]` | « 14,2 k tokens · 2,10 € ». On stocke `cost_tokens`, aucun taux. → **`settings['pricing.eur_per_mtok']`**, converti à l'affichage, jamais stocké en base |

Deux champs sont **dérivés** et ne doivent surtout pas être stockés :

- **`loop`** (`run` | `wait` | `fail` | `done` | `pause`) est un statut *projet*, agrégé depuis l'état du run courant. Le stocker créerait deux sources de vérité qui divergeraient au premier crash.
- **`age` / `ageMin`** se calculent depuis `blocked_since` (items bloquants) ou `created_at` (les autres). C'est précisément pourquoi la Phase 1 a séparé ces deux colonnes.

---

## Contrats à respecter

**Du garant (v0.3) :** la sécurité vit côté serveur · aucun test ne consomme de tokens · les 3 gates sont infranchissables · pas de texte libre vers la machine à états.

**Du pack DA** (`docs/design/CLAUDE.md`, qui fait foi) :
- **HIVE** partout dans l'UI ; le fichier reste `MajordomeStrip.dc.html`, la clé de rôle reste `majordome`.
- **Jamais de tiret cadratin dans l'UI.** Séparateur « · ». C'est une règle stricte, elle s'applique aussi aux chaînes rendues par le backend.
- Rail nav **transparent, 60 px fixes, icônes seules**, ne s'étend pas au hover. Pas de top bar : les indicateurs flottent.
- ~80 % des bordures supprimées, séparation par espacement et hiérarchie typo. Labels de section en mono petites caps espacées (0.16–0.18em).
- Inbox : items **sans cadres** (liseré sémantique 2 px + séparateur fin), panneau de traitement **transparent**.
- Champ d'étoiles `ambiance.js` (opacité 3–6 %) + halo radial accent sur **toutes** les pages.
- **Une seule orbe par vue**, un seul canvas. Pause hors viewport.

**Les moteurs du pack DA s'importent tels quels.** `tokens.css`, `ambiance.js`, `oscilloscope.js`, `logo-globe.js`, `orb.js` sont la référence : on les copie dans `apps/web/src/vendor/`, on ne les réécrit pas, on ne les reformate pas. `docs/design/` reste exclu de Biome — la copie dans `apps/web` doit l'être aussi.

---

## Task 1 — Migration 0003 : les champs que l'UI exige

**Mécanique : exécution directe autorisée.**

- [ ] `apps/server/src/db/migrations/0003_ui_fields.sql` :

```sql
-- Teinte propre au projet : cluster dans l'orbe, pastille dans les listes.
-- Distincte de globes.color, qui teinte le globe entier.
alter table projects add column tint text;

-- Ligne de synthèse rédigée par Hive (« Le dev itère sereinement · prod du
-- step 3 à valider »). Rédigée, pas calculée : le front ne doit jamais tenter
-- de la reconstituer à partir de l'état.
alter table projects add column synth text;

-- Rôle qui a levé l'item. L'UI l'affiche à côté du titre ; sans lui, on ne
-- peut pas distinguer une question du garant d'une question du dev.
alter table inbox_items add column from_role text;
```

- [ ] Étendre `src/db/types.ts`. Test : les trois colonnes acceptent `null` et se relisent.
- [ ] `settings['pricing.eur_per_mtok']` seedé à une valeur par défaut documentée comme approximative.
- [ ] Commit : `feat(db): champs tint, synth et from_role exiges par l'UI`

---

## Task 2 — Repo d'inbox et résolution

**Subagent obligatoire** (touche la reprise des runs).

**Files:** `src/inbox/repo.ts`, `src/inbox/resolve.ts` · Test `tests/inbox.test.ts`

- [ ] **Le repo** : `listInbox({status, type, projectId})`, `getInboxItem(id)`, `createInboxItem(...)`. Le tri par défaut suit l'UI : items ouverts, plus anciens d'abord (`blocked_since` pour les bloquants, `created_at` sinon).
- [ ] **`resolveInboxItem(db, id, response)`** :
  - marque l'item `done`, écrit `human_response` et `resolved_at` ;
  - si `archive_to_client` et que l'item porte une question, append dans `clients.notes` (brief §7) ;
  - **si l'item bloquait un run**, émet `human_resolved` via `applyEvent` et ré-enfile le job — **dans la même transaction que le passage à `done`**. Un item résolu sans run repris, ou un run repris sans item résolu, sont deux états incohérents qu'aucun retry ne rattrape.
- [ ] **Tests** : un item résolu passe `done` avec sa réponse · un item bloquant fait repartir le run depuis `resume_state` · un item non bloquant ne touche pas l'état du run · résoudre deux fois est refusé · une erreur pendant la reprise laisse l'item `open` (prouvé en comptant).
- [ ] Commit : `feat(inbox): repo et resolution avec reprise transactionnelle du run`

---

## Task 3 — Flux SSE `/api/events`

**Subagent obligatoire.**

**Files:** `src/api/events.ts`, `src/events/bus.ts` · Test `tests/sse.test.ts`

- [ ] **Un bus d'événements en mémoire** (`EventEmitter`), alimenté par l'orchestrateur et le repo d'inbox. Types diffusés : `inbox.new`, `inbox.resolved`, `run.state`, `budget.tick`. Charge minimale — un identifiant et un type, jamais l'objet complet : le front rechargera. Ça évite de diffuser un secret par inadvertance et garde le flux lisible.
- [ ] **`GET /api/events`** authentifié, `text/event-stream`, heartbeat toutes les 15 s (sinon les proxys coupent), nettoyage de l'abonnement à la déconnexion. **Tester la fuite** : ouvrir puis fermer 50 connexions et vérifier que le nombre d'abonnés retombe à zéro. Une fuite d'abonnés est invisible jusqu'au jour où le process meurt.
- [ ] Commit : `feat(api): flux SSE typé pour inbox, runs et budget`

---

## Task 4 — Routes REST de l'inbox et des projets

**Mécanique : exécution directe autorisée.**

- [ ] `GET /api/inbox?status=&type=&project=` · `POST /api/inbox/:id/resolve` · `GET /api/projects` · `GET /api/projects/:id` · `/:id/steps` · `/:id/runs`.
- [ ] `GET /api/projects` rend **exactement la forme de `PROJECTS[]` dans `data.js`**, `loop` et `conso` dérivés. C'est ce contrat qui permet au front de brancher les prototypes sans traduction.
- [ ] Toutes authentifiées, validation zod aux frontières, tests d'intégration par route.
- [ ] Commit : `feat(api): routes inbox et projets alignees sur data.js`

---

## Task 5 — Critère J6 : une question bloque puis reprend un run

**Subagent obligatoire.**

- [ ] Test d'intégration `FakeAdapter` : un agent pose une question bloquante → le run passe `awaiting_human`, un item apparaît, `run.state` et `inbox.new` sont diffusés → résolution via l'API → le run repart depuis `resume_state` et le job est ré-enfilé.
- [ ] `scripts/smoke-inbox.ts` : la même chose en ligne de commande, timeline affichée.
- [ ] Commit : `test(inbox): une question bloque puis reprend un run (critere J6)`

---

## Task 6 — Socle UI : tokens, ambiance, rail, HiveStrip

**Subagent obligatoire** (fidélité au pack DA).

- [ ] Copier les moteurs du pack dans `apps/web/src/vendor/` **sans les modifier** et **exclure ce dossier de Biome**.
- [ ] TanStack Router + Query. Layout : rail nav 60 px transparent icônes seules (Dashboard, Inbox, Globes, Clients, Réglages), champ d'étoiles, halo radial, pas de top bar.
- [ ] `<HiveStrip>` monté en bas de toutes les pages : oscilloscope, micro rond, champ pilule. Le fil de conversation et ⌘K arrivent à la Task 8.
- [ ] **Comparer le rendu au prototype** (`MajordomeStrip.dc.html`) et rapporter les écarts constatés, pas seulement « c'est fait ».
- [ ] Commit : `feat(web): socle UI, rail nav et HiveStrip`

---

## Task 7 — Écran Inbox

**Subagent obligatoire** (écran prioritaire du brief §12).

- [ ] `Inbox.dc.html` fait foi. Items sans cadres, liseré sémantique 2 px, séparateur fin, panneau de traitement transparent.
- [ ] Les **5 panneaux typés** : question, approval·email, approval·prod, verdict, alert. Le sous-type `approval·savoir` est rendu mais jamais alimenté dans cette phase.
- [ ] Branché sur `GET /api/inbox` + SSE. Résoudre un item relance réellement la boucle — **c'est le critère de fin J7**.
- [ ] Commit : `feat(web): ecran Inbox et ses 5 panneaux de traitement`

---

## Task 8 — Dashboard, page Globes, ⌘K

**Subagent obligatoire.**

- [ ] Dashboard (`Dashboard.dc.html`) : brief du matin en panneau de verre flottant, chips de compteurs, boucles aérées, budget replié.
- [ ] Page Globes (`Globes.dc.html`) : système solaire, une orbite par globe, Hive au centre, breadcrumb. CRUD globe minimal (formulaire simple ; la création conversationnelle via Hive est une clause de débordement).
- [ ] ⌘K dans le HiveStrip : recherche projets et inbox, navigation. Rien d'autre en v0.
- [ ] **Une seule orbe par vue.** Pause hors viewport.
- [ ] Commit : `feat(web): dashboard, page globes et palette de commandes`

---

## Critère de fin de Phase 3

Traiter un item d'inbox **dans le navigateur** relance réellement une boucle, et la navigation Globes → Projets fonctionne. C'est le critère J7 du brief.

## Hors périmètre

Conscience collective (phase dédiée) · juge visuel J8 · verdict et itérations J9 · communicant J10 · staging et gate prod J11 · budget J12 · orbe v2 complète avec focus J13 · les 15 autres écrans du pack.

## Points ouverts

1. **Org GitHub `desura` n'appartient pas à Florian** — bloquant à J11 pour le dépôt pilote.
2. **`rate_limit_event` jamais observé** malgré ~13 000 tokens réels — le scheduler J12 pourrait n'avoir aucune source.
3. **Le calendrier est à refaire.** J5/14 atteint, un sous-système entier ajouté.
4. **Qui écrit `projects.synth` ?** Hive, mais à quel moment — à chaque transition, ou sur demande ? À trancher avant la Task 4.

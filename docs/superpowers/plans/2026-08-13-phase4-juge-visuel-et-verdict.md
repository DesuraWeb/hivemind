# Silithid — Phase 4 (J8–J9) : Juge visuel et verdict

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fermer la boucle. Le juge visuel capture les pages du step, les compare aux critères d'acceptation et produit un rapport structuré ; le garant rend son verdict ; en cas d'écarts la boucle repart pour une itération avec des prompts correctifs, jusqu'à convergence ou épuisement de `max_iterations`.

**Architecture:** Deux nouveaux handlers d'état (`deploying`, `judging`) et un troisième complété (`verdict`). Playwright tourne dans le process serveur, un seul navigateur réutilisé. Les captures sont des fichiers sur disque référencés dans `artifacts` — jamais des blobs en base. Le juge **décrit**, le garant **décide** : cette séparation est dans les prompts et dans les schémas de sortie, pas seulement dans l'intention.

**Tech Stack:** ajouts — `playwright` (Chromium uniquement)

---

## Le problème de dépendance à résoudre d'abord

**Le juge visuel a besoin d'une URL servie.** Le staging réel (workflow GitHub, rsync vers cPanel) est J11. Et `DesuraWeb/silithid-sandbox` est un projet Node sans interface : il n'y a rien à capturer.

**Décision : un aperçu local remplace le staging jusqu'à J11.** L'état `deploying` sert le worktree du run sur un port éphémère, le juge capture cette URL, puis le serveur s'arrête. C'est fidèle à la machine à états (l'état `deploying` fait bien quelque chose et émet `ci_green`), ça n'anticipe rien de J11, et ça rend la boucle démontrable aujourd'hui.

**Conséquence : le sandbox doit avoir une surface visuelle.** Ajouter au dépôt `DesuraWeb/silithid-sandbox` un site statique minimal (`index.html`, une feuille de style, deux pages) pour que les steps puissent porter sur du rendu. Sans ça, J8 n'est pas démontrable.

---

## Contrats à respecter

**Du garant (v0.3), inchangés :** la sécurité vit côté serveur · aucun test ne consomme de tokens · les 3 gates sont infranchissables · pas de texte libre vers la machine à états.

**Le schéma `verdict` est déjà figé** dans `src/runtime/structured.ts` depuis la Phase 2 :

```ts
verdictSchema = {
  decision: 'conforme' | 'ecarts',
  ecarts: [{ severite: 'bloquant'|'majeur'|'mineur', description, correctif }],
  dev_prompt_correctif?: string
}
```

Ne le redéfinis pas. Il attendait cette phase.

**Le prompt du juge est déjà écrit** (`src/db/seeds/role_templates/judge.md`) et exige une sortie JSON `{conformites[], ecarts[{severite, page, viewport, description, screenshot_ref}]}`. Il faut désormais la valider par zod comme les autres, via `collectStructured`.

**La machine à états gère déjà** `ci_green`, `ci_red`, `judge_report`, `verdict_conforme`, `verdict_ecarts` et l'épuisement de `max_iterations`. Elle est testée sur 165 combinaisons. **Ne la modifie pas** : cette phase branche des handlers sur des transitions qui existent.

---

## Task 1 — Playwright et le module de capture

**Subagent obligatoire.**

**Files:** `src/integrations/playwright.ts` · `src/artifacts/store.ts` · Test `tests/capture.test.ts`

- [ ] **Établir d'abord comment le juge verra les images.** L'outil `Read` du SDK lit les PNG et les présente visuellement au modèle. C'est la voie naturelle : le juge reçoit des chemins de fichiers et une politique `fs: 'read'` sur le dossier d'artifacts, plutôt qu'un encodage base64 dans le prompt. **Vérifie-le contre les types du SDK et par un essai réel**, et écris le constat en commentaire. Si ça ne marche pas, dis-le avant d'écrire le reste.

- [ ] **Un seul navigateur pour tout le process** (brief §3 : « pool d'une instance »). Lancement paresseux au premier usage, fermeture propre à l'arrêt du serveur. Une fuite de navigateur Chromium est bien plus coûteuse qu'une fuite de connexion.

- [ ] **`capturePages(url, paths, artifactsDir)`** : pour chaque page et chacun des 3 viewports (mobile 390, tablette 768, desktop 1440), un PNG pleine page et une extraction texte du DOM. Nommage déterministe (`<runId>/<slug-page>-<viewport>.png`) — un nom aléatoire rendrait la timeline d'audit illisible.

- [ ] **`src/artifacts/store.ts`** : enregistre chaque fichier dans la table `artifacts` (`kind`, `path`, `meta`). **Le chemin est relatif à `ARTIFACTS_ROOT`**, jamais absolu : un chemin absolu de la machine de dev n'a aucun sens après la bascule VPS.

- [ ] **Tests sans réseau** : servir une page statique locale dans le test, capturer, vérifier que les trois PNG existent, ont des dimensions différentes, et que les lignes `artifacts` pointent des chemins relatifs qui résolvent.

---

## Task 2 — L'état `deploying` : aperçu local

**Subagent obligatoire.**

**Files:** `src/loop/steps/deploying.ts` · `src/integrations/preview.ts` · Test `tests/preview.test.ts`

- [ ] Sert le worktree du run sur un port éphémère (`0`), le temps de la capture. Écrit l'URL dans un `message` d'audit, émet `ci_green`.
- [ ] **Toujours arrêter le serveur**, y compris si la capture échoue. Un serveur oublié bloque un port et fuit un descripteur à chaque run.
- [ ] Émet `ci_red` avec une raison si le worktree n'a rien de servable — la machine à états sait déjà quoi en faire (`awaiting_human` + alerte).
- [ ] Documente en tête du fichier que **ceci remplace le staging jusqu'à J11**, pour que personne ne le prenne pour l'implémentation définitive.

---

## Task 3 — Le rôle juge

**Subagent obligatoire** (prompt de rôle).

**Files:** `src/loop/steps/judging.ts` · `src/runtime/structured.ts` (ajout du schéma) · `src/db/seeds/role_templates/judge.md` (ajustement) · Test `tests/judging.test.ts`

- [ ] **`judgeReportSchema`** en zod, conforme au prompt existant :

```ts
{
  conformites: string[],
  ecarts: [{
    severite: 'bloquant' | 'majeur' | 'mineur',
    page: string,
    viewport: 'mobile' | 'tablette' | 'desktop',
    description: string,
    screenshot_ref: string,
  }]
}
```

`screenshot_ref` doit correspondre à un artifact réellement enregistré — **valide-le côté serveur**, un juge qui invente une référence produit un rapport inexploitable.

- [ ] Session juge : `{ bash: false, fs: 'read', mcp: [] }` sur le dossier d'artifacts du run. Il reçoit les critères d'acceptation du `frame` (lus depuis le bus), les chemins des captures, et les extractions DOM.
- [ ] Écrit le rapport dans un `message` `report` juge→garant, émet `judge_report`.
- [ ] **Le prompt dit déjà « tu décris, tu ne décides pas ».** Vérifie que la sortie structurée ne contient aucun champ de décision, et ajuste le prompt si le modèle déborde.

---

## Task 4 — Le verdict du garant

**Subagent obligatoire** (contrat figé).

**Files:** `src/loop/steps/verdict.ts` · Test `tests/verdict.test.ts`

- [ ] Le garant reçoit : le `frame` initial, le rapport du reviewer, le rapport du juge, **et `iteration` / `max_iterations`**. Son prompt (réécrit en Phase 2) attend explicitement ces deux derniers et sait qu'à la dernière itération il arbitre ce qu'il sacrifie.
- [ ] Sortie structurée `verdictSchema` via `collectStructured`. Émet `verdict_conforme` ou `verdict_ecarts`.
- [ ] Sur `ecarts` : le `dev_prompt_correctif` est écrit dans un `message` `correction` garant→dev, que `framing.ts` devra lire à l'itération suivante.
- [ ] **Un écart cosmétique non couvert par un critère d'acceptation n'est pas un écart** (règle du prompt). Teste ce cas : un rapport de juge avec un seul écart `mineur` hors critères doit pouvoir donner `conforme`.

---

## Task 5 — L'itération complète

**Subagent obligatoire.**

**Files:** `src/loop/steps/framing.ts` (lecture des correctifs) · Test `tests/loop-j9.test.ts` · `scripts/smoke-loop-full.ts`

- [ ] `framing.ts` à l'itération 2+ : lit le dernier `message` `correction`, l'injecte dans le préambule, et produit un `frame` corrigé plutôt qu'un cadrage à neuf.
- [ ] **Test de la boucle complète avec le `FakeAdapter`** : un juge scripté qui signale un écart bloquant, puis conforme au tour suivant. Vérifie que l'itération s'incrémente, que le `review_round` est remis à zéro, et que la timeline d'audit contient les passations dans le bon ordre.
- [ ] **Test de l'épuisement** : `verdict_ecarts` à la dernière itération → `failed` + inbox `alert`. La machine à états le fait déjà ; ce test prouve que le câblage l'atteint.
- [ ] `scripts/smoke-loop-full.ts` : la boucle entière sur le sandbox avec de vrais modèles. Rapporte le nombre d'itérations, le coût total et l'URL de la PR.

---

## Critère de fin de Phase 4

Sur `DesuraWeb/silithid-sandbox`, un step réel traverse `framing → coding → reviewing → deploying → judging → verdict` et se conclut soit par une approbation en inbox (mode `gated`), soit par une itération corrective qui converge. Le rapport du juge est structuré, ses `screenshot_ref` pointent des captures réelles, et toute la timeline est consultable.

## Hors périmètre

Communicant et Gmail (J10) · staging réel et gate prod (J11) · scheduler de budget (J12) · orbe v2 avec focus (J13) · conscience collective (phase dédiée) · les 18 écrans restants du pack.

## Task 6 — Le 4ᵉ gate : auto-modification des fichiers de sécurité

**Validé par Florian le 13/08.** Subagent obligatoire (sécurité).

**Files:** `src/loop/steps/coding.ts` · `src/domain/run-state.ts` (nouvel effet) · Test `tests/gate-selfmod.test.ts`

Silithid peut modifier son propre code : son dépôt est un dépôt comme un autre. Trois choses **sont** la frontière de sécurité :

- `apps/server/src/domain/run-state.ts` — la machine à états, donc les gates eux-mêmes
- `apps/server/src/runtime/tools.ts` — la traduction d'une `ToolPolicy` en restriction effective
- la colonne `roles.tools` — les droits accordés à un rôle sur un projet

- [ ] À l'ouverture d'une PR, comparer les chemins modifiés à cette liste. Une correspondance lève un item d'inbox **distinct** (pas un `approval:step_end` ordinaire) qui dit explicitement ce qui est touché et pourquoi c'est différent.
- [ ] **Ce n'est pas une interdiction** : c'est l'impossibilité que ça passe dans le flux ordinaire. Le run continue son cours ; l'item est levé en parallèle.
- [ ] La liste des chemins surveillés vit dans un réglage (`settings['security.guarded_paths']`), pas en dur : elle grandira.
- [ ] **Test** : une PR touchant `tools.ts` lève l'item ; une PR ordinaire n'en lève pas ; la liste est bien lue depuis les réglages.

---

## Constat de qualité à trancher — le garant a peut-être tamponné

Lors du run réel de fin de Phase 4 (35 494 tokens, PR #3), le juge a rendu **0 conformité et 6 écarts, dont un bloquant**. Le garant a répondu **`conforme`, avec une liste d'écarts vide**.

**La plomberie est vérifiée correcte à chaque maillon** : le juge reçoit bien les `acceptance_criteria` (lus depuis `meta` du cadrage), et le garant reçoit le rapport complet du juge (`formatJudgeReport` détaille chaque écart avec sa sévérité, sa page, son viewport et sa description). Ce n'est donc pas un défaut de câblage.

Deux lectures possibles, et on ne peut pas trancher sans une observation réelle :

1. **Le garant a eu raison.** Son prompt lui dit qu'« un écart cosmétique non couvert par un critère d'acceptation n'est pas un écart ». Si le step ne portait que sur un lien « Contact » et que le juge a commenté la mise en page générale d'une page de démonstration volontairement nue, écarter les 6 est le comportement correct. La sévérité est l'avis du juge, pas une mesure de la portée du step.
2. **Le garant a tamponné.** Auquel cas la boucle valide du travail non conforme, ce qui vide de son sens tout le pipeline.

**Le vrai signal d'alarme est le « 0 conformité ».** Si le lien Contact a bien été ajouté (le reviewer a dit OK, les tests passaient), le juge aurait dû constater au moins cette conformité-là. Un juge qui ne trouve aucune conformité sur un travail que le reviewer valide, puis un garant qui déclare conforme, est une combinaison contradictoire.

**À faire avant de s'appuyer sur cette boucle :** un run réel avec conservation des fixtures (ne pas nettoyer en fin de smoke), pour lire les trois passations telles qu'elles ont été échangées. Le correctif sera probablement dans le prompt du juge — lui rappeler qu'il juge **contre les critères d'acceptation**, pas dans l'absolu.

---

## Points ouverts hérités

1. **`rate_limit_event` jamais observé** malgré des milliers de tokens réels. Le scheduler J12 pourrait n'avoir aucune source ; sa règle de péremption deviendrait le comportement nominal.
2. **`hive.answer_baseline`** contient mes suppositions, pas les constantes de travail réelles de Florian.
3. **Le 4ᵉ gate** (auto-modification de `run-state.ts`, `tools.ts`, `roles.tools`) reste à arbitrer.
4. ~~Le calendrier~~ **Tranché le 13/08 : les numéros de jour sont abandonnés.** Ils cadraient un sprint de deux semaines qui n'existe plus (la conscience collective a été ajoutée au périmètre). On travaille par phases. L'ordre reste : finir la boucle (cette phase), puis arbitrer entre le reste du pipeline (communicant, staging, budget) et la conscience.

5. ~~Le 4ᵉ gate~~ **Tranché le 13/08 : validé**, devient la Task 6 de cette phase.

6. ~~`hive.answer_baseline`~~ **Rempli le 13/08** avec les vraies règles de Florian, et découpé : socle universel + `hive.stack_rules` injectées selon `projects.stack`. Deux règles restent marquées RÈGLE MANQUANTE (tunnel de commande PrestaShop, Pest ou PHPUnit sur Le Koin).

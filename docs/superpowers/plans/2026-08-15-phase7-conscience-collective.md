# Phase 7 — La conscience collective

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Ce qui fait que la plateforme apprend. Florian, le 14/08 : « le premier
déploiement d'un site Astro ne doit pas être le même que le 15ᵉ, parce qu'il
aura appris de ses erreurs, des bonnes pratiques, saura appliquer tel ou tel
SEO directement ».

## Le problème de dépendance à résoudre AVANT d'écrire quoi que ce soit

**Un agent consulte-t-il réellement la mémoire quand il devrait ?**

Toute cette phase repose là-dessus : archiver du savoir ne sert à rien si
personne ne le lit. `client_kb.lookup` vient d'être câblé (15/08) après avoir
été promis à trois rôles pendant six phases sans exister. **Aucun agent ne
l'a encore appelé, et rien ne prouve qu'il le fera** — un agent qui ne trouve
pas un outil ne plante pas, il s'en passe, et c'est exactement pour ça que le
manque a survécu si longtemps.

- [ ] **Diagnostic contrôlé, avant toute autre tâche.** Une fiche client
  contenant la réponse à une question que le cadrage rend nécessaire. On lance
  le garant. Deux issues, et elles n'appellent pas le même travail :
  l'agent appelle `client_kb.lookup` et n'ouvre pas de question — le socle
  tient ; ou il pose la question quand même — et il faut d'abord régler ça,
  parce que tout le reste en dépend.
- [ ] **Mesurer, pas supposer** : `AgentResult.toolCalls` porte les appels
  réellement observés. C'est ce canal qu'on lit, pas le texte de la réponse.
- [ ] Coût : un échange. Écrire le constat ici avant de continuer, comme
  `diag-juge-garant.ts` l'a fait pour le juge.

### Constat du 15/08 — le socle tient

`scripts/diag-rappel.ts`, un échange. Vérité terrain : une fiche client
contenant « Marie valide les contenus, jamais son alternante, la prévenir
48 h avant », et un cadrage qui rend cette information nécessaire.

Mesuré sur `AgentResult.toolCalls`, pas sur le texte de la réponse :

```
outils appelés      : mcp__client_kb__lookup
a consulté la fiche : OUI
```

Et sa réponse : « La fiche client répond déjà aux deux points : Marie, la
gérante, valide personnellement les contenus (jamais son alternante) et doit
être prévenue 48 h à l'avance — **je n'ai donc aucune question à poser à
l'humain**, et je peux cadrer en intégrant ce délai. »

**Le rappel ne fait pas que se produire : il change le comportement.** L'agent
consulte, trouve, cite, et renonce à une question qu'il aurait posée sinon.
C'est exactement le mécanisme que cette phase doit industrialiser — il est
prouvé sur un cercle (le client), il reste à l'étendre aux trois autres et à
faire naître les savoirs tout seuls.

## Les contrats

- **Le savoir s'accumule tout seul, le pouvoir ne s'élargit que par une
  décision humaine.** Arbitrage de Florian, 14/08. Une recette qui s'enrichit :
  c'est le but. Un catalogue de capacités qui s'élargirait de lui-même : c'est
  un système qui s'accorde des droits.
- **La formulation de Florian fait foi.** Le cycle est TROUVAILLE →
  PROPOSITION → **CORRECTION** → ARCHIVAGE → RAPPEL. Un agent propose, il
  n'archive jamais.
- **Les propositions de savoir sont silencieuses.** Elles ne réveillent jamais
  une boucle, elles attendent la revue du matin (spec, §02).
- **Les fiches clients et les secrets ne sont JAMAIS empruntables** entre
  globes (spec, §05).
- **Le plus spécifique gagne** : projet → client → globe → Hive.

---

## Task 1 — Les trois cercles, en base

**Files:** migration · `src/knowledge/store.ts` · Test

- [ ] Une table `savoirs` : le contenu, le **cercle** (projet / client / globe /
  hive) et son identifiant, la **version**, l'origine (run, item d'inbox),
  l'horodatage, et l'état (actif / archivé).
- [ ] **Versionné, jamais écrasé.** Corriger un savoir crée une version ; la
  précédente reste lisible. C'est ce qui rend une révocation possible plus
  tard, et c'est ce que le pack affiche (`v1`, `v2`).
- [ ] `clients.notes` porte déjà un proto-savoir (`{q, a, source_item_id,
  at}`), lu par `client_kb`. **Décide** : migration vers la nouvelle table, ou
  cohabitation ? Une seconde source de vérité sur le même savoir divergera —
  ce projet a déjà tranché ce genre de question deux fois (statut projet,
  journal) en refusant le stockage dupliqué. Justifie.
- [ ] **Test** : un savoir corrigé conserve son historique · le cercle le plus
  spécifique gagne · un savoir archivé n'est plus rappelé.

## Task 2 — Le rappel en cascade

**Files:** `src/knowledge/recall.ts` · `src/knowledge/client-kb.ts` · Test

- [ ] `client_kb.lookup` ne rend plus seulement la fiche client : il rend la
  cascade — projet, puis client, puis globe, puis Hive — le plus spécifique
  d'abord.
- [ ] **Chaque rappel incrémente un compteur** sur le savoir rappelé. C'est le
  score d'utilité du pack (« × 12 rappels », « jamais rappelée » en ambre), et
  c'est lui qui alimentera la revue de péremption.
- [ ] **Décide où l'incrément est écrit** : dans la même transaction que la
  lecture, ou en différé ? Un agent qui consulte dix fois dans un run ne doit
  pas produire dix écritures bloquantes. Justifie.
- [ ] **Test** : la cascade rend le plus spécifique · un savoir de globe
  n'atteint pas un projet d'un autre globe · le compteur bouge réellement.

## Task 3 — La trouvaille et la proposition

**Files:** `src/knowledge/propose.ts` · `src/loop/steps/verdict.ts` · Test

- [ ] **Où naît un savoir.** La spec dit « fin de run · le reviewer extrait les
  candidats ». Le reviewer ne parle pourtant qu'en `OK`/`KO` avec une liste de
  points (`structured.ts`). **Tranche** : nouveau champ dans son schéma, ou
  extraction par le garant au moment du verdict, qui a déjà tout le contexte ?
  Justifie — et n'ajoute pas un échange de modèle par run sans le dire.
- [ ] Item d'inbox `approval` / sous-type `savoir`, avec sa **source** (run,
  diff) et le **cercle visé**, comme le pack l'affiche.
- [ ] **Silencieux et groupé** : ces items ne réveillent aucune boucle et ne
  déclenchent aucune alerte. Vérifie ce que ça implique dans
  `domain/run-state.ts` — et si ça n'implique rien, dis-le, c'est une bonne
  nouvelle.
- [ ] Trois actions : archiver tel quel · corriger puis archiver · refuser.
  **La formulation corrigée fait foi**, jamais celle de l'agent.
- [ ] **Test** : un savoir proposé n'avance ni ne bloque le run · la correction
  est ce qui est archivé · un refus n'archive rien et ne repropose pas la même
  chose au run suivant.

## Task 4 — Le conflit de savoirs

**Files:** `src/knowledge/conflict.ts` · `apps/web/src/components/inbox/panels/` · Test

- [ ] Une proposition qui contredit un savoir actif du même cercle lève un item
  de **conflit** : l'existant et la proposition côte à côte, et trois issues —
  remplacer, garder, fusionner à la main (`sv-203` du pack).
- [ ] **Décide comment on détecte une contradiction.** Deux textes libres qui
  se contredisent, ce n'est pas décidable par comparaison de chaînes. Un
  modèle ? Une clé de sujet posée à l'archivage ? Justifie, et si la détection
  est imparfaite, dis-le dans l'item plutôt que de laisser croire à une
  certitude.
- [ ] Le sous-type existe déjà côté front (`SavoirPanel`, aujourd'hui inerte).
- [ ] **Test** : deux savoirs contradictoires lèvent un conflit · fusionner
  produit une nouvelle version, pas une troisième entrée concurrente.

## Task 5 — Ce qui reste vivant : la revue de péremption

**Files:** `src/knowledge/review.ts` · `apps/web/src/routes/RevueSavoirs.tsx` · Test

- [ ] Écran `Revue des savoirs.dc.html`, guidé par Hive, trimestriel : pour
  chaque savoir, « toujours vrai · garder » ou « plus d'actualité · archiver ».
- [ ] **Ce que Hive propose en priorité** : les savoirs jamais rappelés, et les
  plus anciens. Le score d'utilité de la Task 2 sert enfin à quelque chose.
- [ ] Les non-traités **reviennent** : une revue quittée en cours de route ne
  perd rien.
- [ ] **Test** : un savoir jamais rappelé remonte en tête · archiver le retire
  du rappel sans effacer son historique.

## Task 6 — Rendre `stack_rules` vivant

**Files:** `src/db/seeds/baseline.ts` · `src/knowledge/store.ts` · Test

- [ ] `hive.stack_rules` est aujourd'hui une **mémoire morte** : écrite une
  fois, jamais modifiée. C'est exactement ce que cette phase doit corriger.
- [ ] Un savoir archivé dans le cercle **Hive**, portant une stack, rejoint les
  règles injectées pour cette stack. Le recouvrement privé
  (`seeds/prive/stack-rules.json`) reste le socle de départ ; le savoir appris
  s'y ajoute, il ne l'écrase pas.
- [ ] **La ligne à ne pas franchir**, rappelée : une règle apprise ne peut
  jamais introduire une capacité. Elle informe un agent, elle ne lui donne
  aucun droit.
- [ ] **Test** : un savoir de stack archivé apparaît dans l'injection du projet
  concerné · pas dans celle d'un projet d'une autre stack.

## Task 7 — L'emprunt entre globes

**Files:** `src/knowledge/borrow.ts` · Test

- [ ] Les globes sont **étanches par défaut**. Un agent qui a besoin d'un
  savoir d'un autre globe **demande un emprunt** — item d'inbox, comme tout le
  reste.
- [ ] Deux issues : accorder en **lecture seule**, ou **copier** (fork
  indépendant, qui suivra sa propre vie).
- [ ] Tracé (qui, quoi, quand) et **révocable**.
- [ ] **Les fiches clients et les secrets ne sont JAMAIS empruntables.** Pas un
  réglage, pas une case à décocher : une impossibilité, prouvée par un test —
  même exigence que pour `gmail_send` et le shell.
- [ ] **Test** : prouver l'impossibilité d'emprunter une fiche client · un
  emprunt révoqué cesse d'être rappelé · un fork survit à la révocation.

---

## Critère de fin de Phase 7

Un savoir découvert pendant un run est proposé en inbox, corrigé par Florian,
archivé dans le bon cercle, puis **réellement rappelé** au run suivant — et le
compteur d'utilité le prouve. Deux runs sur la même stack ne partent pas du
même point de départ.

## Hors périmètre

L'agent d'exploitation (Phase 6, plan écrit) · le staging réel · le suivi
client (écarté par Florian).

## Ce qui attend Florian

Rien pour cette phase. Les deux questions ouvertes (voie du staging, secrets
Gmail) ne la bloquent pas.

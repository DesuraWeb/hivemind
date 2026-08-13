# Phase 5 — Le monde réel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

La boucle tourne de bout en bout et son verdict veut dire quelque chose (Phase 4, doute levé le 13/08). Ce qui manque est tout ce qui sort de la machine : la consommation réelle du compte, un vrai staging, la mise en prod, et le premier agent qui parle à un humain qui n'est pas Florian.

## Le problème de dépendance résolu d'abord

**Tranché le 13/08 avant d'écrire la suite du plan.** Le scheduler de budget reposait sur `rate_limit_event`, jamais observé en plusieurs milliers de tokens réels. Deux diagnostics, quelques dizaines de tokens en tout :

`scripts/diag-rate-limit.ts` — l'évènement **arrive bien**, sous le nom exact que `captureRateLimit` écoute. Mais son `rate_limit_info` ne contient **pas** `utilization` :

```
{"status":"allowed","resetsAt":1786635600,"rateLimitType":"five_hour",
 "overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false}
```

Le SDK type `utilization?: number` en optionnel, et le serveur ne l'envoie pas. `captureRateLimit` sortait donc en `return` silencieux à chaque évènement, depuis toujours. Ni « l'évènement n'existe pas », ni « on écoute le mauvais nom » : on lisait un champ absent.

`scripts/diag-usage-api.ts` — et surtout : **le constat de Phase 1 écrit en tête de `runtime/claude.ts` est faux** pour le SDK 0.3.227. Il existe bien une API d'usage, sur l'objet `Query` :

```ts
usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
```

Mesuré réellement : réponse en **1 seconde**, `total_cost_usd: 0`, **sans consommer le flux** — donc sans le moindre tour de modèle. `subscription_type: "max"`, `rate_limits_available: true`, et exactement les deux jauges du pack DA :

```
five_hour  → utilization 5,  resets_at 2026-08-13T15:39:59Z
seven_day  → utilization 29, resets_at 2026-08-18T17:59:59Z
```

La règle du garant (« jamais de tokens dépensés juste pour mesurer ») est respectée à la lettre, pas contournée. **Mais le nom de la méthode est un avertissement explicite du SDK** — « DO NOT RELY ON THIS API YET ». On s'en sert, et on tombe proprement si elle disparaît : c'est la Task 1.

## Contrats à respecter

- La sécurité vit côté serveur. Le communicant **rédige**, il n'envoie pas : Gmail n'expose que la création de brouillon, au niveau de la configuration serveur, et l'envoi est une action serveur après validation humaine.
- Une mise en prod est un gate, jamais un automatisme, quel que soit le mode de boucle.
- Rien qui touche à la configuration serveur d'un client (`.htaccess`, nginx, `php.ini`, cron) — règle dure de Florian, valable pour les agents comme pour le déploiement.
- Subagents obligatoires : prompts de rôles (donc le communicant), machine à états. Direct autorisé pour le mécanique.

---

## Task 1 — `usage()` dit enfin la vérité

**Files:** `src/runtime/claude.ts` · `src/runtime/types.ts` · Test `tests/usage.test.ts`

- [ ] Remplacer le corps de `usage()` par un appel à l'API d'usage du SDK, **sans jamais itérer le flux** : c'est ce qui la rend gratuite. Ouvrir un `query()` éphémère, appeler la méthode, `interrupt()` en `finally` — sinon le sous-processus du SDK survit au process.
- [ ] **Tomber proprement.** Le nom de la méthode dit « ne comptez pas dessus ». Trois cas à distinguer honnêtement, jamais à confondre : la méthode a disparu (`typeof !== 'function'`) · elle échoue · `rate_limits_available: false` (clé API, Bedrock, Vertex). Dans les trois, `available: false` — le scheduler ne met alors **jamais** un projet en pause, contrat déjà écrit dans `types.ts`.
- [ ] Replier les fenêtres hebdomadaires comme le fait déjà `captureRateLimit` : maximum de toutes les variantes `seven_day*` non nulles. Sous-estimer ferait tourner le scheduler trop longtemps ; surestimer ne coûte qu'une pause prématurée.
- [ ] Remonter `resets_at` : le pack DA l'affiche (`BUDGET.reset`), et sans lui la jauge ne dit pas quand elle se vide.
- [ ] **Corriger le commentaire de tête de `claude.ts`**, qui affirme le contraire depuis la Phase 1. Le laisser serait pire que de ne rien écrire : quelqu'un le relira et refera le mauvais choix.
- [ ] `captureRateLimit` : garder la capture opportuniste, mais **écrire dans le code pourquoi elle ne suffit pas** (le champ `utilization` n'est pas envoyé). Elle ne sert plus que de source secondaire si l'API expérimentale disparaît.
- [ ] **Test sans tokens** : un faux objet `Query` couvrant les cinq cas (nominal, méthode absente, méthode qui jette, `rate_limits_available: false`, fenêtres hebdo multiples à replier).

## Task 2 — Le scheduler de budget

**Files:** `src/budget/scheduler.ts` · `src/jobs/` (cron pg-boss) · Test `tests/budget.test.ts`

- [ ] Sonde périodique (cron pg-boss). Gratuite, donc la fréquence n'est pas un compromis de coût — mais elle reste un appel réseau : quelques minutes, pas quelques secondes.
- [ ] Règle du garant, à appliquer telle quelle : mesure **fraîche ≤ 90 min**. Au-delà, jauge « inconnu » et le scheduler applique **la dernière valeur majorée de 10 points**. Avec l'API de la Task 1 la mesure sera presque toujours fraîche : cette règle redevient ce qu'elle devait être, une dégradation, pas le régime nominal.
- [ ] Seuils dans les réglages, pas en dur. Franchissement → `budget_pause` sur les runs actifs (la machine à états sait déjà) ; retour sous le seuil → `budget_resume`.
- [ ] La réserve (`BUDGET.reserve` du pack) : ce qu'on garde pour les urgences, jamais consommé par une boucle ordinaire.
- [ ] **Test** : jauge qui franchit le seuil → pause ; qui redescend → reprise ; mesure périmée → majoration de 10 points ; `available: false` → **jamais** de pause.

## Task 3 — Le staging réel

**Files:** `src/deploy/` · `src/loop/steps/deploying.ts` · Test

**Bloqué sur une réponse de Florian** — voir « Ce que j'attends de toi » en bas. Tout ce qui ne dépend pas de la réponse est fait d'abord : l'interface, le gate, les tests avec un pilote factice.

- [ ] `DeployTarget` en interface, comme `RuntimeAdapter` : le pilote rsync/SSH est une implémentation, pas le contrat. Les vieux projets clients sont sur cPanel/OVH et n'auront pas tous la même voie.
- [ ] Remplacer l'aperçu statique local de `deploying.ts` — documenté depuis la Phase 4 comme provisoire — sans perdre la capture du juge, qui doit maintenant viser l'URL de staging réelle.
- [ ] Les accès vivent dans le coffre (libsodium), jamais dans un réglage en clair, jamais dans un dépôt.
- [ ] **Aucune écriture dans la configuration serveur du client.** On dépose des fichiers, on ne touche pas à `.htaccess`, nginx, `php.ini` ni au cron.

## Task 4 — Le gate de mise en prod

**Files:** `src/loop/steps/` · `src/domain/run-state.ts` (subagent obligatoire) · Test

- [ ] Une mise en prod est **toujours** un item d'inbox, quel que soit le mode de boucle du step. Le mode `full-auto` porte sur l'itération dev↔reviewer, jamais sur la prod.
- [ ] L'item porte de quoi décider sans ouvrir un terminal : ce qui change, le verdict du garant, l'URL de staging vérifiée, et le moyen de revenir en arrière.
- [ ] **Le rollback fait partie du gate, pas d'un plan B.** Règle de Florian : une migration sans rollback propre, ce n'est pas fini.
- [ ] **Test** : un step en `full-auto` lève quand même le gate prod.

## Task 5 — Le communicant

**Files:** `src/loop/roles/` (prompt — subagent obligatoire) · `src/integrations/gmail.ts` · Test

- [ ] **Il rédige, il n'envoie jamais.** Le brouillon est créé côté Gmail ; l'envoi est une action serveur déclenchée par une validation humaine en inbox, jamais par l'agent.
- [ ] La restriction est **de configuration serveur** : le serveur MCP Gmail n'expose que la création de brouillon. Comme pour les outils (Phase 1), le test du gate consiste à **prouver l'impossibilité**, pas à constater une abstention.
- [ ] Ton : direct, chaleureux, sans blabla, aucun jargon technique avec un client. **La fiche client fait foi** sur le ton — le prompt doit aller la lire, pas improviser.
- [ ] Séparateur « · », jamais de tiret cadratin. Dates FR, HT/TTC corrects.
- [ ] **Test** : l'agent ne peut pas envoyer, même en le demandant explicitement.

---

## Critère de fin de Phase 5

La jauge de budget affiche des chiffres réels et met en pause pour de vrai. Un step du dépôt pilote se déploie sur un staging réel, le juge capture cette URL, et la mise en prod attend une validation humaine qui dispose de tout pour décider. Un brouillon d'email existe dans Gmail sans qu'aucun agent n'ait eu le pouvoir de l'envoyer.

## Hors périmètre

Conscience collective (phase dédiée, la suivante) · orbe v2 avec focus · les 18 écrans restants du pack.

## Ce que j'attends de Florian

Rien ne bloque les Tasks 1, 2, 4 et 5. Deux questions bloquent la Task 3, et deux règles restent en suspens depuis le 13/08 :

1. **Le staging du dépôt pilote** : où vit-il, et par quelle voie on y dépose (SSH/rsync, FTP cPanel, git pull côté serveur, autre) ?
2. **Les accès** : à mettre dans le coffre. À ne jamais coller dans un message — un chemin de dépôt, ou le nom d'une entrée de gestionnaire de mots de passe.
3. **PrestaShop** : les contraintes sur le tunnel de commande et le checkout (`RÈGLE MANQUANTE` dans `hive.stack_rules`).
4. **Le Koin** : Pest ou PHPUnit (`RÈGLE MANQUANTE`).

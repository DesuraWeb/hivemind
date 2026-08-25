# Création conversationnelle · Hive arme l'orbe

**Date** · 2026-08-25
**État** · validé, section par section

## Le problème

L'écran de Création rejoue une conversation préscriptée. Les cinq répliques de
Hive sont des `setTimeout` (300, 4200, 8200, 11400, 15000 ms) dans
`components/creation/script.ts`, et la fiche se remplit par un formulaire qui
n'a aucun rapport avec elles. Le doc-comment de `routes/Creation.tsx` le dit
sans détour : « aucun agent n'écoute cet écran ». Un bouton « ⟲ rejouer la
conversation » rend le théâtre explicite.

Florian ne veut plus cliquer à gauche et à droite pour poser un nom. Il veut
parler à un agent qui le challenge et qui s'occupe de la création.

## Ce qu'on construit

Hive devient l'assistant de création d'orbe et de démarrage de projet. D'une
discussion, il sort une orbe armée et un premier projet lançable.

Il **challenge** · il lit les orbes, les clients, les savoirs de la ruche et les
stacks des projets passés, il cherche sur le web, et il conteste un découpage
qui sent mauvais.

Il **vérifie** · le dépôt existe-t-il, le staging répond-il.

Il **crée** · l'orbe, puis le projet avec ses steps, son roster dans `roles`
avec le prompt de chaque agent, et les savoirs semés dans les bons cercles.

## Architecture

### Persistance · une table

`creations` porte une conversation et son brouillon.

    id            uuid
    fiche         jsonb   -- identité, steps, roster, mémoire proposée
    conversation  jsonb   -- le fil, en ordre
    statut        text    -- en_cours | aboutie | abandonnee
    globe_id      uuid    -- ce qui a été créé, quand ça aboutit
    project_id    uuid
    cost_tokens   bigint  -- pour que ces jetons apparaissent dans le budget
    created_at, updated_at

**Écartées** · `messages` est le bus inter-agents (`run_id`) et porte déjà la
conversation du bandeau HiveStrip avec `run_id = null` ; y loger la création
polluerait ce fil. `agent_sessions` est attachée à un run.

**Une table et pas deux** · dix à trente tours par création. Réécrire la ligne
coûte moins qu'une seconde table qu'on n'interrogera jamais par message.

**`fiche` et `conversation` séparées** · les corrections manuelles n'écrivent
que dans `fiche`, sans jamais toucher à ce que Hive a dit.

**Pas de `session_id`** · `askHive` rejoue l'historique depuis la base à chaque
tour au lieu d'utiliser `resume`. On suit ce motif éprouvé : un rafraîchissement
reprend la conversation sans machinerie.

### La surface d'outils de Hive

Motif existant · des surfaces MCP en process montées par usage
(`createOpsReadSurface`, `createClientKbSurface`).

**Lire** · `lire_contexte` (orbes, clients, savoirs du cercle hive, stacks
passées), `verifier_depot`, `sonder_url` (réutilise la sonde serveurs),
`WebSearch`.

**Remplir** · `proposer_fiche` émet une retouche partielle. C'est la pièce qui
rend vrai « les écrans se remplissent d'eux-mêmes » · continu, pas en fin de
conversation.

**Créer** · `creer_orbe`, `creer_projet`.

### Deux garde-fous

**Hive ne crée que ce qui est à l'écran** · les outils d'écriture n'acceptent
que ce qui a transité par `proposer_fiche`. Pas de clic de confirmation, mais
rien n'est écrit que Florian n'ait vu se remplir.

**Une création est annulable d'un geste** · `globe_id` et `project_id` rendent
le défaire trivial. Sans ça, « il s'occupe de tout » veut dire « il salit la
base et tu nettoies à la main ».

### WebSearch

Natif au SDK, donc pas une dépendance. Une ligne dans `runtime/tools.ts`, qui
n'autorise aujourd'hui que Bash, Read, Glob, Grep, Write, Edit.

Ce que ça coûte · un appel sortant, et **du contenu non fiable en retour**. Un
résultat de recherche qui contient des instructions n'est pas une consigne. Le
prompt système le cadre, et l'outil reste limité à cette surface · les agents
de la boucle ne l'obtiennent pas au passage.

## L'écran

La composition ne bouge pas · orbe au centre, fragments autour.

- **Le choix « Un projet / Un globe » disparaît.** Hive déduit de la discussion
  s'il faut une orbe neuve.
- **La phrase centrale est sa dernière réplique**, sur plusieurs lignes quand
  il en faut, champ de saisie dessous.
- **Un contrôle déploie le fil complet** par-dessus la scène.
- **L'oscilloscope montre le tour en vol** · `speak` pendant que Hive
  travaille, `idle` quand il attend. Un challenge avec recherche prend quinze à
  trente secondes ; sans signal on croit que c'est cassé.
- **Les fragments se remplissent depuis `proposer_fiche`**, l'étape avance
  quand un fragment a du contenu. `script.ts` disparaît.
- **Chaque champ reste éditable à la main** · l'échappatoire quand Hive n'a pas
  compris le nom.
- **La panne se voit sur place** · modèle injoignable, budget à sec, outil en
  échec. La fiche reste remplissable avec le CTA actuel.
- **Le CTA devient « ouvrir le projet → »**, et ne reste un bouton « créer »
  que sur le chemin dégradé.

## La voix

Pas une liseuse d'écran · une capacité de conversation. Florian appuie, parle,
ça s'écrit ; Hive répond, ça se dit à voix haute, ce qui lui permet de
travailler sans les yeux sur l'écran.

**Reconnaissance** · `SpeechRecognition` avec `processLocally`, plus
`available()` et `install()` pour le pack de langue. Zéro paquet, l'audio ne
sort pas de la machine.

Par défaut Chrome envoie l'audio à un serveur. `processLocally` n'est donc pas
un confort, c'est la condition : **si le local n'est pas disponible, le bouton
n'apparaît pas**, plutôt qu'une bascule silencieuse vers la reconnaissance
serveur. L'API n'est pas Baseline (Firefox ne l'a pas) · détection à
l'exécution. Arc est sur Chromium.

**Synthèse** · `speechSynthesis`, voix du système, hors ligne, gratuit.

**Les pannes s'entendent** · la règle est d'apprendre un échec depuis l'écran ;
quand on a délibérément quitté l'écran, une panne muette est pire. Voix active
= échec dit à voix haute. Coupure globale, pour un bureau partagé.

Un hook partagé, pour que la deuxième surface conversationnelle l'ait
gratuitement.

## Découpage

**Lot 0 · le roster.** `roles.enabled` n'est lu par personne aujourd'hui :
désactiver un agent ne fait rien. Le rendre effectif, et permettre à
`createProject` de recevoir un roster (rôle activé + prompt sur mesure) et des
savoirs à semer. Le roster par défaut existe déjà — `resolveProjectRole`
matérialise paresseusement depuis `role_templates`. Aucun agent, testable seul.

**Lot 1 · la conversation réelle.** Table, session, tours, `proposer_fiche`,
fragments pilotés par la donnée, zone déployable, panne visible, `script.ts`
supprimé. Hive parle et remplit, n'écrit rien d'autre. **À la fin de ce lot, la
conversation rejouée n'existe plus.**

**Lot 2 · les droits d'écriture.** `creer_orbe`, `creer_projet` avec roster et
mémoire, `WebSearch`, annulation.

**Lot 3 · la voix.** Reconnaissance locale, synthèse, coupure, pannes audibles,
oscilloscope sur les vrais états. Ne dépend que du lot 1.

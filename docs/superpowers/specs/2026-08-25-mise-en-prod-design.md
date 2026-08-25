# De l'hébergement du client au déploiement qui apprend

**Date** · 2026-08-25
**État** · cadrage validé section par section

## Ce qu'on veut pouvoir faire

Arriver, créer une orbe, cadrer un projet avec Hive, le développer, et le
mettre en ligne — **sur n'importe quelle stack et n'importe quel
hébergement**, sans jamais parler aux sous-agents. Et que chaque déploiement
raté rende le suivant meilleur.

Le produit ne connaît pas de liste de stacks supportées et n'en connaîtra
pas. React, Astro, Python, Java, PrestaShop : ce qui rend l'agnosticisme réel
n'est pas un catalogue de cas particuliers, c'est **la recette éditable en
base plus la mémoire qui la remplit**. Coder une stack en dur serait la seule
façon de garantir qu'on ne les couvre jamais toutes.

## Décisions prises

- **Silithid pousse en prod, après approbation.** Le code ET les migrations
  qu'il porte, avec une sauvegarde juste avant. Prix assumé : restaurer perd
  ce que les visiteurs ont écrit depuis.
- **Pas de second agent d'exploitation.** Le rôle `ops` existe (Phase 6). Un
  deuxième dupliquerait le coffre, le catalogue borné, la sonde et la piste
  d'audit — et couperait en deux la mémoire que `savoirs.domaine =
  'exploitation'` sert à réunir.
- **Le staging est permanent, pas une phase.** Pas de cycle de vie linéaire :
  la question est « ce projet a-t-il une cible de prod », et les deux cibles
  coexistent ensuite pour toujours.
- **`auto` par défaut, l'inbox comme seul point de contact.** Sans effet sur
  la prod : `runProdGate` se déclenche quel que soit le mode d'autonomie, et
  c'est déjà le cas.
- **La mémoire de déploiement est rappelée en cascade** (voir lot A).

## Ce qui existe déjà, et qu'il ne faut pas réécrire

**La boucle d'apprentissage tourne.** `ops/apprendre.ts` propose des savoirs
depuis trois sources — ce que le juge a trouvé, ce que Florian a corrigé en
validant, ce qui a cassé après coup — câblées dans l'inbox, le provisioning
et les demandes de changement.

**Le gate de prod est déjà honnête.** `resolveStaging` distingue une URL
déclarée d'une URL vérifiée. `buildRollback` refuse de se déclarer déterminé
dès qu'une migration est dans le step.

**Le déploiement est déjà une abstraction.** `DeployTarget`, avec l'aperçu
local et le SSH+git.

---

## Lot A · La mémoire indexée sur le bon couple

**Le correctif le plus rentable du chantier, et il vient de l'exemple de
Florian.**

`recettePourStack(db, stack)` est indexée sur la stack seule. Or « Astro chez
PlanetHoster demande de monter PHP » n'est pas un fait sur Astro : Astro sur
un VPS n'a aucun PHP. Rangé sous `astro`, ce savoir sera rappelé à
contretemps la moitié du temps — et **un rappel faux coûte plus cher qu'un
rappel absent**, parce qu'il fait perdre du temps ET décrédibilise les autres.

### La cascade

Même mécanique que les cercles de mémoire (`projet → client → globe → hive`),
qui existe et est éprouvée. Le rappel cherche du plus précis au plus général :

1. `stack × hébergeur nommé` — « Astro chez PlanetHoster »
2. `stack × type d'hébergement` — « Astro sur mutualisé »
3. `stack` seule — « Astro »

Chaque savoir déclare à quel niveau il vaut. Hive décide de ce niveau au
moment de proposer, et **il se trompera parfois** : c'est le coût accepté de
la précision, et l'écran de revue des savoirs existe pour le corriger.

Concrètement : une colonne d'hébergement sur `savoirs`, nulle quand le savoir
vaut pour toute stack confondue.

### Le vide se dit

Quand aucun des trois niveaux ne rend rien, Hive l'annonce au lieu de
proposer avec un aplomb qu'il n'a pas : « je n'ai jamais posé d'Astro sur du
mutualisé · voilà ce que je vais devoir découvrir ». L'absence de mémoire
devient une information plutôt qu'un silence indistinguable de la confiance.

---

## Lot B · L'hébergement du client

`serveurs.type` : `vps` | `mutualise`, et l'hébergeur nommé.

**Le type filtre le catalogue à la construction de la surface, pas dans le
prompt.** Quatre des six opérations sont impossibles sur du mutualisé :
`installer_paquet` (pas d'apt), `activer_extension_php` (un panneau),
`recharger_service` (pas de systemctl), `poser_cron` (le panneau, le plus
souvent). Un agent à qui on demande de ne pas proposer l'impossible le
proposera un jour ; une opération non déclarée, jamais.

**Le rattachement au client et au projet.** Sans lui, `serveurs` est un parc
plat et l'agent ne peut pas répondre à « où vit ce client ».

**Les gestes du mutualisé.** Déployer s'y réduit à poser des fichiers. Rien de
privilégié à ajouter.

### Le pré-vol

Avant un premier déploiement sur un couple neuf, une passe de lecture relève
les versions réellement en place (PHP, Node, extensions) et les compare à ce
que la stack exige. Trouver un PHP 7.4 avant de pousser coûte une minute ; le
trouver pendant coûte un site cassé.

---

## Lot C · Où démarre le projet

Entre dans la conversation de création, au même titre que le dépôt. Trois cas,
et aucun n'est imposé :

- **Staging d'abord**, prod plus tard.
- **Prod directement** — un site interne, un jetable, un projet où le staging
  ne vaut pas son coût.
- **Déjà hébergé** sur un domaine existant, qu'on reprend.

Hive pose la question, vérifie ce qu'il peut vérifier (le domaine répond-il,
qu'y a-t-il déjà), et remplit la fiche.

---

## Lot D · Les deux cibles

Une configuration de déploiement par projet : staging et prod, chacune
rattachée à un serveur. Hôte, chemin, branche, domaine.

Les accès viennent du coffre par serveur (`ops.<nom>.ssh_private_key`) : pas
un secret de plus, et pas d'accès unique qui ouvrirait tout le parc.

`projects.staging_url`, une chaîne déclarée que le gate refuse déjà de croire,
disparaît au profit de l'URL réellement déployée.

**Le staging survit à la mise en prod.** C'est ce qui permet de ne pas prendre
de risque sur la prod : on pousse sur le staging, le juge y passe, et la
promotion en prod est un second geste sur du code déjà vu tourner.

---

## Lot E · La mise en prod

Déclenchée par **l'approbation du gate**, jamais par la boucle. Ça préserve la
propriété qu'a déjà le gate : une mise en prod survit au run et peut arriver
trois jours plus tard.

### Les migrations, en trois temps dont aucun n'est optionnel

1. **Sauvegarde, puis vérification de la sauvegarde.** Pas « la commande a
   rendu 0 » : on relit le dump, on vérifie qu'il n'est pas vide et qu'il se
   lit. Une sauvegarde qui a échoué en silence est pire que pas de sauvegarde,
   parce qu'elle autorise le geste suivant.
2. **Migration.**
3. **Restauration automatique si elle échoue**, sans attendre une décision
   humaine.

Sur du mutualisé, ces trois temps ne passent pas par les mêmes commandes —
d'où la dépendance au lot B.

### Le gate montre le prix avant

Quelles migrations vont jouer, où va le dump, et ce que restaurer ferait
perdre.

---

## Lot F · Le déploiement apprend

**Le trou actuel** : les trois sources d'apprentissage écoutent le
provisioning et les demandes de changement, parce que ça passe par l'agent
d'exploitation. Un déploiement passe par `DeployTarget`, un chemin qui
n'apprend rien — et c'est exactement là que les erreurs de version se
produisent.

Un déploiement raté, une commande qui échoue, une version qui ne convient
pas : tout ça remonte comme savoir, au bon niveau de la cascade.

---

## Lot G · Vérifier après

Après une mise en prod, le juge repasse sur l'URL réelle et une alerte se lève
si ça ne va pas.

Sans ça, « déployé » veut dire « la commande n'a pas rendu d'erreur », ce qui
n'est pas la même chose — et Florian l'apprendrait par un client, ce qui est
exactement la règle qu'il a posée.

---

## Risques à surveiller

**L'inbox devenue illisible.** « L'inbox comme seul point de contact » ne tient
que si elle reste lisible. Le jour où elle porte les mises en prod, les
conflits de savoir, les bornes atteintes et les propositions de mémoire de six
projets en parallèle, elle cessera d'être lue — et le silence par défaut
deviendra un silence subi. À surveiller dès qu'il y a plus de deux projets
actifs.

**Le catalogue d'opérations élargi** est la surface la plus sensible du
produit : un agent qui écrit sur un site client en production. Chaque
opération ajoutée doit être aussi bornée que les six existantes — paramètres
validés, aucune commande libre, `MOTS_INTERDITS` toujours en garde.

**Une recette fiable par stack est un vrai travail.** Le chantier vaut ce que
vaut la recette de la stack sur laquelle il tourne. Mieux vaut une couverte
sérieusement que quatre approximées — non pas pour limiter le produit à une
stack, mais parce que la mémoire ne se remplit qu'en tournant pour de vrai.

**La fenêtre entre sauvegarde et restauration** perd le contenu écrit par les
visiteurs. Inhérent au choix assumé ; la seule atténuation est qu'elle reste
courte.

---

## Hors périmètre, noté

**La page d'accueil en assistant de société.** Hive en Jarvis : « bonjour
Florian », le point du matin, ce qui a été fait dans la nuit, les rendez-vous
à venir via un connecteur d'agenda. Le journal de nuit existe déjà et c'est sa
matière première. Chantier distinct, à ne pas mélanger à celui-ci.

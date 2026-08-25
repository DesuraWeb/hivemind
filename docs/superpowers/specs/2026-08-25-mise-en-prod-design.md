# La mise en production · de l'hébergement du client au déploiement vérifié

**Date** · 2026-08-25
**État** · cadrage validé par Florian, section par section

## La question de départ

« On peut choisir si on met ça sur du staging ou sur le domaine définitif au
lancement du projet ? Peut-on démarrer un projet sur du staging et après dire
"j'ai transféré en prod" mais faut quand même faire des modifications pendant
ce temps ? »

Réponse honnête aujourd'hui : non aux deux, et pas pour la même raison.

## Ce que le produit modélise réellement aujourd'hui

**La boucle ne connaît que le staging.** `deploying` reçoit une `DeployTarget`
(`deploy/types.ts`) : soit un aperçu local éphémère
(`deploy/local-preview.ts`), soit un vrai staging par SSH et git
(`deploy/ssh-git.ts`) dont l'URL est dérivée du slug. Le domaine définitif
n'est pas une cible que la boucle sait écrire.

**La prod n'est pas un déploiement, c'est une décision.** `runProdGate` lève
un item d'inbox à la fin d'un step réussi — sans condition sur `autonomy`, le
mode `auto` ne portant que sur l'itération dev↔reviewer. Rien ne pousse en
production.

**`projects.staging_url` est décoratif.** Une chaîne déclarée, affichée par
`projects/repo.ts`. `resolveStaging` refuse déjà de la compter comme vérifiée
et dit quand le juge n'a statué que sur un aperçu local — c'est la bonne
posture, et c'est aussi l'aveu qu'il n'y a pas de vraie configuration.

**Il n'existe aucun état « ce projet est en ligne ».** Un projet en
construction et un site vivant depuis six mois sont identiques pour le
système.

**`buildRollback` est déjà honnête** : il refuse de se déclarer déterminé dès
qu'un fichier de migration est dans le step, en disant que le retour arrière
du schéma n'est pas déductible. C'est la règle de Florian, déjà tenue.

## Décisions prises

- **Silithid pousse en prod, après approbation** — pas Florian à la main.
- **Le code ET les migrations qu'il porte**, avec une sauvegarde juste avant.
  Florian a choisi ce chemin en connaissance du prix : restaurer perd ce que
  les visiteurs ont écrit depuis la sauvegarde.
- **Pas de second agent.** Le rôle `ops` existe depuis la Phase 6. Un
  deuxième rôle qui parle aux serveurs dupliquerait le coffre par serveur, le
  catalogue borné, la sonde et la piste d'audit — et couperait en deux la
  mémoire que `savoirs.domaine = 'exploitation'` sert précisément à réunir.

---

## Lot A · L'hébergement du client

Prérequis de tout le reste : une configuration de déploiement pointe vers un
serveur, et si ce serveur ne dit pas de quel type il est, la mise en prod ne
saura pas si elle a le droit de recharger un service.

### Le type d'hébergement filtre le catalogue

`serveurs.type` : `vps` | `mutualise`.

Quatre des six opérations sont **impossibles** sur du mutualisé :
`installer_paquet` (pas d'apt), `activer_extension_php` (un panneau, pas un
fichier), `recharger_service` (pas de systemctl), `poser_cron` (le panneau, le
plus souvent). La colonne `sudo` modélise « on préfixe ou pas », pas « ce
geste n'existe pas ici ».

Le filtrage a lieu à la **construction de la surface**, pas dans le prompt :
un agent à qui on demande de ne pas proposer l'impossible le proposera un
jour. Les opérations indisponibles ne sont pas déclarées au modèle.

### Le rattachement

Un serveur appartient à un client, et un projet déploie sur un serveur. Sans
ça, la table est un parc plat et l'agent ne peut pas répondre à « où vit ce
client » — la question la plus banale qu'on lui posera.

### Ce qui manque pour le mutualisé

Déployer s'y réduit à poser des fichiers. Les gestes à ajouter sont ceux-là et
rien de privilégié.

---

## Lot B · Le cycle de vie du projet

`projects.etat_vie` : `en_construction` | `en_ligne`, plus la date de mise en
ligne. C'est ce qui rend « j'ai transféré en prod » exprimable, et ce qui fait
changer de sens le reste :

- Le gate ne demande plus « on lance ? » mais « on touche à du vivant ? ».
- Le juge a une référence réelle.
- La garde sur les URL indexées devient active — casser une URL indexée est
  la faute la plus chère, et aujourd'hui rien ne distingue le moment où elle
  devient possible.

---

## Lot C · Deux cibles réelles

Une configuration de déploiement par projet : une cible de staging, une cible
de prod, chacune rattachée à un serveur existant. Hôte, chemin, branche,
domaine.

Les accès viennent du coffre par serveur (`ops.<nom>.ssh_private_key`) : pas
un secret de plus à gérer, et pas d'accès unique qui ouvrirait tout le parc.

`staging_url` déclaré disparaît au profit de l'URL réellement déployée, celle
que `resolveStaging` sait déjà distinguer.

---

## Lot D · La mise en prod

Déclenchée par **l'approbation du gate**, jamais par la boucle. Ça préserve la
propriété qu'a déjà le gate et qui est bonne : une mise en prod survit au run
et peut arriver trois jours plus tard. Même mécanique que le staging
(`createSshGitTarget`), autre cible.

### Les migrations, en trois temps dont aucun n'est optionnel

1. **Sauvegarde, puis vérification de la sauvegarde.** Pas « la commande a
   rendu 0 » : on relit le dump, on vérifie qu'il n'est pas vide et qu'il se
   lit. Une sauvegarde qui a échoué en silence est pire que pas de sauvegarde,
   parce qu'elle autorise le geste suivant.
2. **Migration.**
3. **Restauration automatique si elle échoue**, sans attendre une décision
   humaine.

Sur du mutualisé, ces trois temps ne passent pas par les mêmes commandes que
sur un VPS — d'où la dépendance au lot A.

### Le gate montre le prix avant

Quelles migrations vont jouer, où va le dump, et le fait que restaurer perd ce
que les visiteurs ont écrit depuis. Dit une fois, clairement, à l'endroit de
la décision.

---

## Lot E · Vérifier après

Après une mise en prod, le juge repasse sur l'URL réelle et une alerte se lève
si ça ne va pas.

Sans ça, « déployé » veut dire « la commande n'a pas rendu d'erreur », ce qui
n'est pas la même chose — et Florian l'apprendrait par un client, ce qui est
exactement la règle qu'il a posée : savoir depuis l'écran, jamais par
quelqu'un d'autre.

---

## Réserves à garder en vue

**Le catalogue d'opérations n'a rien pour déployer ni migrer.** L'élargir est
la surface la plus sensible du produit : un agent qui écrit sur un site client
en production. Chaque opération ajoutée doit être aussi bornée que les six
existantes — paramètres validés, aucun passage de commande libre, `MOTS_INTERDITS`
(`shell`, `exec`, `run`, `bash`…) toujours en garde.

**Une recette de déploiement fiable par stack est un vrai travail.** Ce
chantier vaut ce que vaut la recette de la première stack sur laquelle il
tourne. Mieux vaut une stack couverte sérieusement que quatre approximées.

**La fenêtre entre sauvegarde et restauration** perd le contenu écrit par les
visiteurs. Inhérent au choix assumé ; la seule atténuation est qu'elle reste
courte.

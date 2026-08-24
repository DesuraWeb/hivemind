# hivemind

Un orchestrateur d'agents. Une boucle **garant → dev → reviewer → juge**, des
portes humaines aux endroits qui comptent, et une mémoire qui apprend.

> Nom interne du code : `silithid`. Les deux désignent la même chose.

## Ce que ça fait

Vous décrivez un step. Le **garant** le cadre et pose des critères
d'acceptation vérifiables. Le **dev** code dans un worktree isolé et ouvre une
PR. Le **reviewer** relit et boucle avec lui, dans une limite d'itérations. Le
**juge** capture les pages à trois viewports et décrit ce qu'il voit — il ne
décide pas. Le garant tranche, et rend un verdict.

Un **communicant** propose un email au client quand quelque chose est mis en
ligne. Un **agent d'exploitation** parle aux serveurs : il prépare un
hébergement neuf, et sur une machine en production il propose un plan que vous
validez et que Silithid applique — sans que vous ayez à taper les commandes.

Rien ne part en production sans vous. Rien n'est envoyé à un client sans vous.
Rien ne change sur un serveur qui sert déjà sans vous.

## Ce qui est vrai, et ce qui ne l'est pas

Ce dépôt évite une chose avec obstination : **afficher ou promettre un état
qu'il n'a pas**. Une jauge sans mesure dit « inconnu » plutôt que zéro. Un
bouton sans destinataire est absent, pas grisé. Une capture en erreur ne
devient jamais un rapport de juge.

Concrètement, aujourd'hui :

- La boucle tourne de bout en bout, avec de vrais modèles, sur un vrai dépôt.
  Trois peuvent avancer en même temps (`LOOP_CONCURRENCY`), chiffre calé sur la
  RAM disponible et l'absence de swap, pas choisi au hasard.
- Le déploiement se fait sur un **aperçu local** : le staging réel est écrit
  (`DeployTarget` + une cible SSH/git) mais n'a jamais tourné contre un vrai
  serveur.
- Gmail fonctionne en brouillon seulement, et n'a jamais parlé au vrai Gmail.
- L'agent d'exploitation est complet et **n'a jamais touché une vraie machine** :
  la sonde, le catalogue et l'exécution sont testés contre un faux serveur.
- La conscience collective apprend, et vous rappelle la revue quand la file
  grandit ou qu'un mois a passé — jamais plus souvent.
- Les recettes de déploiement s'enrichissent seules à partir de trois signaux :
  ce que le juge a trouvé, ce que vous avez corrigé en validant, ce qui a cassé.
  Le quinzième déploiement d'une stack n'est plus le premier.

## Les frontières de sécurité

Six choses sont **impossibles**, pas seulement interdites — l'impossibilité est
dans le type ou le schéma, et chacune a son test :

- Un agent ne peut pas envoyer un email. Il rédige ; l'envoi exige une
  approbation humaine que lui seul ne peut pas fabriquer.
- Un agent ne peut pas exécuter un outil hors de sa politique. `allowedTools`
  ne bloque rien — c'est `tools` qui restreint, et ça s'est découvert à la dure.
- Un savoir ne s'emprunte pas entre globes sans votre accord, et une fiche
  client ne s'emprunte jamais : la table ne peut pas la désigner.
- Une PR qui touche la machine à états ou la politique d'outils lève un item
  distinct. Ce n'est pas un blocage, c'est l'impossibilité de passer inaperçu.
- L'agent d'exploitation ne peut pas exécuter une commande. Il rend un plan
  inerte ; le catalogue d'opérations est fermé, sans `shell`, `exec` ni `run`,
  et le schéma de sortie n'accepte aucun autre nom.
- Ce qui s'exécute sur un serveur est ce qui vous a été montré. Le plan est figé
  dans l'item d'inbox avec son empreinte ; un plan modifié après validation est
  refusé au lieu d'être appliqué.

Et une dernière, qui vaut pour tout ce que le système apprend : **le savoir
s'accumule tout seul, le pouvoir ne s'élargit que par une décision humaine.**
Une recette gagne des rappels sans rien demander — c'est du texte, ça informe.
Elle ne gagne une ÉTAPE, qui s'exécutera d'office sur les prochains serveurs
vierges, que si vous l'avez approuvée. Et une étape ne peut jamais introduire
une opération absente du catalogue : ça, c'est un commit.

Et une règle qui tient toute la partie exploitation : **un serveur n'est
« vierge » que s'il a été MESURÉ vierge**. Cinq preuves, une seule incertitude
suffit à conclure « en service », et rien dans l'API ne permet de le déclarer à
la main. Un serveur passé en service ne redevient jamais vierge — c'est un
trigger, pas une règle applicative.

## Démarrer

```bash
pnpm install
cp .env.example .env        # puis remplir ; scripts/setup.sh génère les clés
pnpm db:migrate && pnpm db:seed
pnpm dev                    # API sur :3000
pnpm dev:web                # front sur :5173
```

Production : `pnpm build && pnpm start` — un seul processus sert l'API et le
front. Voir [docs/exploitation/deploiement.md](docs/exploitation/deploiement.md).

Il faut Node 22, pnpm, PostgreSQL 16, et Chromium pour Playwright
(`pnpm exec playwright install --with-deps chromium`).

**Aucun globe n'existe à l'installation** : l'écran Globes vous invite à créer
le premier.

## Vos règles

Les agents lisent un socle de règles — ce que « fini » veut dire, ce qu'on ne
fait jamais sans demander. Un défaut générique est versionné ici ; le vôtre se
pose dans `apps/server/src/db/seeds/prive/`, ignoré par git. Voir le
[README](apps/server/src/db/seeds/prive/README.md) de ce dossier.

## Les commentaires renvoient à un pack de design absent

Le front a été construit contre un pack de prototypes qui reste privé : il
porte du contexte métier, et il décrit des écrans **non construits** qu'un
lecteur prendrait pour des fonctionnalités existantes. Les chemins
`docs/design/…` cités en commentaire ne sont donc pas dans ce dépôt. Tout ce
qui est nécessaire à l'exécution est dans `apps/web/src/vendor/`.

## Licence

Pas encore choisie.

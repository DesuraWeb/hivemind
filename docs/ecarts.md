# Les écarts · ce qui manque, et ce que ça coûte

Un seul endroit, tenu à jour. Avant, chaque manque vivait dans un commentaire,
au fond du fichier concerné : on ne pouvait pas décider sans lire tout le code.

Dernière revue : **25/08/2026**, après la première mise en service réelle.

## Comment lire

Chaque ligne dit **ce qui est absent**, si c'est **délibéré** ou **pas fait**,
et **ce que ça coûte** de le combler. La distinction est le point : un manque
délibéré se discute, un manque non fait se planifie.

Les trois sections sont dans l'ordre où je les traiterais.

---

## 1 · Ce qui trahit la règle de la maison

Ce dépôt s'astreint à ne jamais afficher un état qu'il n'a pas. Ces trois
points font l'inverse, dans un sens ou dans l'autre. Ils passent avant tout le
reste parce qu'ils abîment la seule chose qui rende le produit crédible.

| Écart | Nature | Coût |
|---|---|---|
| **L'écran `/conscience` nie la mémoire.** Il déclare « la conscience collective n'existe pas · aucune table de savoirs, aucun rappel compté, aucun emprunt ». C'était vrai quand il a été écrit · la Phase 7 a depuis livré les quatre cercles, le versionnement, le compteur de rappels, l'emprunt entre globes et la revue de péremption. **L'app nie une fonctionnalité qu'elle a.** | pas fait · dette laissée par la Phase 7 | une journée · l'écran doit lire `/api/savoirs`, et les blocs `spec` deviennent `built` |
| **Le micro de la barre Hive fait semblant.** Il s'allume, il anime l'oscilloscope, et il n'écoute rien : ni `getUserMedia`, ni transcription. `RunControls.tsx` a retiré le sien en écrivant « un micro qui ne transcrit rien serait le mensonge le plus coûteux de l'écran » · `HiveStrip.tsx` l'a gardé. | pas fait · incohérence entre deux écrans | voir §3, c'est une décision à prendre |
| ~~**Une panne connue ne se voyait nulle part.**~~ Corrigé le 25/08 · bandeau d'alerte au-dessus de tous les écrans, alimenté par les items d'inbox ouverts. | corrigé | rien |

---

## 2 · Ce qui est délibérément absent, et doit le rester

Rien à faire ici. C'est la liste qu'on relit quand quelqu'un demande
« pourquoi ça ne fait pas X ».

| Absent | Pourquoi |
|---|---|
| Boutons « + Nouveau template », « Historique », « Éditer » des rôles | aucune route ne les sert · un bouton qui ne fait rien est pire qu'un bouton absent |
| Révocation d'une décision dans le journal | il n'existe pas de révocation générique · remettre des gates, redescendre un `max_iterations` et rappeler un email parti sont trois gestes différents, dont un impossible |
| Onglets « Config » et « Équipe » de la fiche projet | rien ne les alimente en lecture comme en écriture |
| Pastilles « Gates humaines / Full-auto » cliquables | aucune route ne change `steps.autonomy` · rendues en lecture seule |
| Bloc « Connexions » des réglages (Gmail, GitHub) | aucune route ne dit si une intégration est connectée · une pastille verte tirée de la présence d'un secret affirmerait un état qu'on ne vérifie pas |
| Rotation des secrets, portée et lecteurs dans le coffre | `settings` est une table de clés plates scellées · sans portée, sans journal d'accès, sans rotation |
| Suivi client | écarté par Florian |
| Contenus WordPress de démonstration | écartés par Florian |

---

## 3 · Ce qui n'est pas fait, et qui se décide

Par ordre de ce que je ferais en premier.

### La dictée vocale · à trancher

Le pack montre un micro et un oscilloscope sur plusieurs écrans. Le produit
n'a **aucune** transcription. Trois voies :

- **Web Speech API** · gratuite, zéro serveur, quelques heures. Mais
  Chrome uniquement, et **l'audio part chez Google** · à écarter pour un
  produit qui garde des secrets clients, sauf à le dire à l'écran.
- **Transcription par API** (Whisper ou équivalent) · deux à trois jours,
  fonctionne partout, coût par minute, et un secret de plus au coffre.
- **Retirer le micro de `HiveStrip`** · une heure. L'écran cesse de mentir,
  et la barre garde son champ texte qui, lui, marche.

Tant que rien n'est décidé, **le micro ment**. Le retirer est le seul geste
qui ne coûte presque rien et qui remet l'écran d'aplomb.

### Le juge visuel obligatoire · deux raisons de le rendre optionnel

Quand le garant ne désigne aucune page, `deploying` retombe sur `/` et capture
quand même. Sur un projet sans interface (une API, une bibliothèque) on paie un
navigateur et un échange de modèle pour regarder une page qui n'existe pas.

Le VPS ajoute une contrainte plus dure : Chromium tient **~300 Mo par instance
en plus des ~285 Mo de l'agent**, et avec `LOOP_CONCURRENCY=3` sur une machine
qui sert deux applications clientes derrière un `MemoryMax=4G`, c'est de la RAM
prise à d'autres.

Coût : une demi-journée · un drapeau `juge_visuel` par projet, et
`deploying`/`judging` sautés quand il est faux.

### Le staging réel · écrit, jamais lancé

`DeployTarget` et la cible SSH/git existent et sont testées contre un dépôt
local. Aucune exécution contre un vrai serveur. Il manque le DNS joker, le
certificat joker par DNS-01 OVH, et le vhost avec authentification HTTP · tout
est documenté dans [staging.md](exploitation/staging.md).

Coût : la mise en place est un geste humain d'une heure · ensuite chaque projet
a son URL sans que personne ne touche à rien.

### Gmail · brouillon seulement

Le communicant rédige, l'envoi exige une validation humaine, et **rien n'a
jamais parlé au vrai Gmail**. Il manque quatre secrets au coffre
(`gmail.oauth.client_id`, `client_secret`, `refresh_token`, `gmail.from`).

Coût : la configuration OAuth côté Google, une heure · le code est là.

### L'agent d'exploitation · jamais sur une vraie machine

Sonde, catalogue borné, plans, sauvegardes, retours arrière : tout est testé
contre un faux serveur. Le premier contact réel jugera les hypothèses de
chemins (`/var/www`, `/etc/nginx/sites-enabled`, `phpenmod`).

**Et un défaut connu** : le catalogue rend ses commandes sans `sudo`. Le compte
`silithid-ops` a un sudoers borné sur le VPS, mais tant que les commandes ne
sont pas préfixées, elles échoueront pour tout compte qui n'est pas root.

Coût : une dizaine de lignes dans `operations.ts` et les tests qui suivent.

### Les recettes ne se remplissent qu'à moitié

Les rappels s'accumulent depuis trois sources. Les **étapes** demandent une
validation humaine, par construction · c'est la ligne. Rien à corriger, mais à
savoir : une recette neuve ne gagne des étapes que si on lui en approuve.

### Le multi-modèle

Attribuer ChatGPT ou un autre CLI à un profil d'agent. Reporté par Florian.
`RuntimeAdapter` est déjà le bon point d'extension · le travail est un second
adaptateur, pas une refonte.

---

## Ce qui bloque, et sur qui

| Attend | Qui |
|---|---|
| Les quatre secrets Gmail | Florian |
| Le DNS joker `*.stg.silithid.com` et son certificat | Florian |
| Un dépôt de test pour la première boucle | Florian · voir [premier-projet.md](exploitation/premier-projet.md) |

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
| ~~**L'écran `/conscience` nie la mémoire.**~~ Corrigé le 25/08 · il lit `GET /api/savoirs/apercu` et rend des chiffres mesurés. Ce qui reste absent (rappel sémantique, déduplication, export) y figure toujours, nommément. Un test refuse que la phrase revienne. | corrigé | rien |
| ~~**Le micro fait semblant.**~~ Retiré le 25/08 de la barre Hive ET de l'écran de création · il y en avait deux. La dictée est mise de côté ; tant qu'elle n'existe pas, l'écran ne la promet plus. | corrigé | rien |
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

### ~~Le juge visuel obligatoire~~ · corrigé le 25/08

Drapeau `juge_visuel` par projet, **activé par défaut**. À faux, `deploying` et
`judging` sont traversés sans navigateur ni échange de modèle, et le garant
reçoit un rapport qui dit que personne n'a regardé — « rien trouvé » et « pas
regardé » ne sont pas la même chose.

La machine à états n'est pas touchée : `decide()` est un fichier sous garde, et
la modifier pour une option de projet aurait été disproportionné.

<details><summary>Le raisonnement d'origine</summary>

Quand le garant ne désigne aucune page, `deploying` retombe sur `/` et capture
quand même. Sur un projet sans interface (une API, une bibliothèque) on paie un
navigateur et un échange de modèle pour regarder une page qui n'existe pas.

Le VPS ajoute une contrainte plus dure : Chromium tient **~300 Mo par instance
en plus des ~285 Mo de l'agent**, et avec `LOOP_CONCURRENCY=3` sur une machine
qui sert deux applications clientes derrière un `MemoryMax=4G`, c'est de la RAM
prise à d'autres.

</details>

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

~~**Et un défaut connu** : le catalogue rend ses commandes sans `sudo`.~~
Corrigé le 25/08 · drapeau `sudo` par serveur, vrai par défaut. Les écritures
passent par `tee` et non par une redirection élevée, qui ne marche pas.

### Les recettes ne se remplissent qu'à moitié

Les rappels s'accumulent depuis trois sources. Les **étapes** demandent une
validation humaine, par construction · c'est la ligne. Rien à corriger, mais à
savoir : une recette neuve ne gagne des étapes que si on lui en approuve.

### Le multi-modèle · écarté

Attribuer ChatGPT ou un autre CLI à un profil d'agent. **Écarté par Florian le
25/08 : le produit tourne sur Claude, et c'est très bien comme ça.**

Noté ici plutôt que supprimé, parce que la question reviendra et que
l'arbitrage vaut d'être retrouvé. `RuntimeAdapter` reste le bon point
d'extension le jour où elle revient. Et la vraie question ne sera pas « quel
modèle » mais **quelle surface** : un CLI en sous-processus a ses propres
outils et son propre bac à sable, donc la `ToolPolicy` de Silithid ne
s'applique pas à lui · une API avec nos outils garde les garanties. Le second
est cohérent avec le produit, le premier est plus rapide.

### L'écran de Création à 375 px · inutilisable

La scène est une composition en positionnement absolu calée sur 1280 px de
large : deux colonnes de fragments ancrées aux bords, l'orbe au centre. Sur un
téléphone, tout se chevauche et rien n'est utilisable.

Ce n'est pas une régression de la création conversationnelle · c'était déjà le
cas quand la scène rejouait un script. Mais **ça ne respecte pas « fini = testé
sur mobile 390 px »**, et c'est le seul écran du produit dans ce cas.

Ce qu'il faudrait : sous une largeur de rupture, empiler verticalement au lieu
de positionner en absolu — conversation, puis identité, puis steps, puis infra.
L'orbe passe en bandeau. C'est son propre lot, pas un ajustement.

### La chaîne outil → écran n'est pas testée de bout en bout

Le faux adaptateur (`runtime/fake.ts`) **rapporte** un appel d'outil sans
l'exécuter : il n'instancie pas les serveurs MCP en process. La chaîne « Hive
appelle `proposer_fiche` → la fiche se remplit → le fragment apparaît » n'est
donc vérifiée que par ses deux moitiés (la forme de la surface, et
l'application des retouches, qui est pure).

Vaut pour toutes les surfaces MCP du dépôt, pas seulement la création. Le jour
où ça compte vraiment, la correction est dans le faux adaptateur : exécuter
réellement l'outil scripté au lieu de l'annoncer.

### Aucun test ne couvre le front

`vitest.config.ts` ne prend que `apps/server/tests`, en environnement `node`.
Tout le code de `apps/web` — dont le hook de voix, sa détection de la
reconnaissance locale et son refus de basculer sur la reconnaissance serveur —
n'est vérifié que par le typecheck et le build.

Y remédier suppose jsdom et un second projet vitest : une dépendance et de la
maintenance, donc un arbitrage de Florian, pas une décision d'implémentation.

---

## Ce qui bloque, et sur qui

| Attend | Qui |
|---|---|
| Les quatre secrets Gmail | Florian |
| Le DNS joker `*.stg.silithid.com` et son certificat | Florian |
| Un dépôt de test pour la première boucle | Florian · voir [premier-projet.md](exploitation/premier-projet.md) |
| Confirmer que le micro apparaît dans Arc | Florian · la reconnaissance locale est détectée à l'exécution, et le panneau de vérification n'a pas pu l'afficher |

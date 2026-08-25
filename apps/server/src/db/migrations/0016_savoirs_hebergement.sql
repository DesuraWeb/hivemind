-- Le niveau auquel un savoir de stack est vrai.
--
-- ## Le problème, dans les mots de Florian
--
-- « Je déploie Astro sur un PlanetHoster · on va voir qu'il y aura des
-- problématiques de version PHP. »
--
-- Ce n'est PAS un fait sur Astro. Astro sur un VPS n'a aucun PHP. Rangé sous
-- `stack = 'astro'` — la seule clé qui existait — ce savoir serait rappelé à
-- contretemps une fois sur deux.
--
-- Et **un rappel faux coûte plus cher qu'un rappel absent** : il fait perdre du
-- temps, et il décrédibilise les rappels justes qui l'accompagnent. Une
-- mémoire dans laquelle on ne peut plus avoir confiance ne vaut pas les jetons
-- qu'elle coûte à injecter.
--
-- ## La cascade
--
-- Même mécanique que les cercles de mémoire (`projet → client → globe → hive`),
-- qui est éprouvée. Le rappel va du plus précis au plus général :
--
--   1. `hebergement = '<hébergeur nommé>'`  — « Astro chez PlanetHoster »
--   2. `hebergement = '<type>'`             — « Astro sur mutualisé »
--   3. `hebergement is null`                — « Astro », partout
--
-- Une seule colonne plutôt que deux : le rappel cherche l'appartenance à un
-- petit ensemble de valeurs candidates (l'hébergeur, puis le type), et le
-- niveau se déduit de LAQUELLE a répondu. Deux colonnes obligeraient à écrire
-- la même règle deux fois et à gérer le cas où elles se contredisent.
--
-- ## `null` est le bon défaut, et il préserve l'existant
--
-- Tous les savoirs déjà en base ont été écrits sans notion d'hébergement : ils
-- valent partout, ce que `null` dit exactement. Aucun d'eux ne change de
-- comportement, et le rappel d'un agent qui n'a pas de contexte d'hébergement
-- (le cadrage d'un dev, par exemple) ne voit toujours qu'eux — un savoir
-- propre à un hébergeur n'a rien à faire dans un cadrage de code.
alter table savoirs add column hebergement text;

-- Le rappel filtre sur (cercle, domaine, stack, hébergement, état). L'index
-- existant `savoirs_stack_domaine_idx` ne porte pas la nouvelle colonne.
create index savoirs_hebergement_idx
  on savoirs (domaine, stack, hebergement)
  where etat = 'actif' and stack is not null;

-- Aucun globe à l'installation.
--
-- La migration 0002 crée un globe « Desura » : c'était nécessaire à l'époque
-- pour rattacher les projets existants, puisque `projects.globe_id` est NOT
-- NULL. Ce besoin est passé, et le nom d'une agence n'a rien à faire dans le
-- schéma d'un projet destiné à être public — une installation neuve doit
-- démarrer vide, et l'écran de Création sait poser le premier globe.
--
-- La 0002 n'est PAS réécrite : une migration appliquée est immuable, sinon
-- deux installations partant du même dépôt divergent. On corrige par-dessus.
--
-- Garde-fou : on ne supprime que si le globe ne porte aucun projet. Sur une
-- base neuve c'est vrai (0002 vient de le créer), donc le résultat est zéro
-- globe. Sur une base où quelqu'un y a rangé des projets, il est conservé —
-- et de toute façon la clé étrangère est en NO ACTION, la suppression
-- échouerait plutôt que d'emporter des projets.
delete from globes
where slug = 'desura'
  and not exists (select 1 from projects where projects.globe_id = globes.id);

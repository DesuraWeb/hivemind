-- Le domaine d'un savoir : le CODE, ou l'EXPLOITATION.
--
-- ## Pourquoi séparer maintenant
--
-- Depuis la Phase 7, un savoir archivé dans le cercle `hive` avec une `stack`
-- rejoint les règles injectées pour cette stack. Un seul destinataire existait
-- alors : le dev et le garant.
--
-- La Phase 6 en a ajouté un second. L'agent d'exploitation apprend lui aussi
-- par stack — « poser le robots.txt dès le premier déploiement », « le cache
-- des assets hashés » — et ce qu'il apprend n'a rien à faire dans le cadrage
-- d'un dev. L'inverse est tout aussi vrai : « eager loading par défaut » est
-- du bruit dans un plan de déploiement.
--
-- Sans cette colonne, les deux prompts recevraient l'union des deux mémoires.
-- Ça coûte des tokens pour du hors-sujet, et surtout ça dilue : une contrainte
-- noyée dans dix contraintes étrangères est une contrainte qu'on ne lit plus.
--
-- ## `code` par défaut, et c'est le bon défaut
--
-- Tous les savoirs existants viennent du garant, donc du code. Un savoir dont
-- personne n'a déclaré le domaine appartient au flux qui existait avant celui
-- qui vient d'arriver — jamais l'inverse, qui déplacerait silencieusement de
-- la mémoire déjà validée vers un destinataire qui ne l'a jamais vue.
alter table savoirs
  add column domaine text not null default 'code'
    check (domaine in ('code', 'exploitation'));

-- Le rappel filtre systématiquement sur (cercle, stack, domaine, état) : sans
-- cet index, chaque cadrage de step relit la table entière.
create index savoirs_stack_domaine_idx
  on savoirs (domaine, stack)
  where etat = 'actif' and stack is not null;

-- Où le projet démarre, et sur quel domaine.
--
-- ## Le staging n'est pas un passage obligé
--
-- Le produit ne connaissait qu'un chemin : on développe sur un staging, et la
-- prod est une décision qui vient après. C'est le bon défaut, ce n'est pas
-- une loi. Trois cas existent réellement :
--
--   · `staging`  — on développe à l'abri, la prod viendra
--   · `prod`     — un site interne, un jetable, un projet où le staging
--                  coûterait plus qu'il ne protège
--   · `existant` — on reprend un site déjà en ligne sur son domaine
--
-- Le troisième est le plus dangereux et c'est celui qui n'était pas
-- représentable : reprendre un site vivant n'est pas la même chose que partir
-- d'une page blanche. Casser une URL indexée y devient possible dès le premier
-- step, et rien ne le disait.
--
-- ## `staging` par défaut, et c'est honnête
--
-- Les projets déjà créés l'ont tous été sous le seul modèle que le produit
-- savait faire. Leur attribuer `staging` n'est pas une supposition, c'est un
-- constat.
--
-- Mais la CONVERSATION de création, elle, l'exige explicitement
-- (`creation/fiche.ts::manquesFiche`) : Hive doit poser la question au lieu de
-- laisser un défaut décider. Un défaut en base sert à ne pas casser
-- l'existant, pas à dispenser de choisir.
alter table projects
  add column demarrage text not null default 'staging'
    check (demarrage in ('staging', 'prod', 'existant'));

-- Le domaine visé, ou celui déjà en service quand on reprend un site.
--
-- Distinct de `staging_url` : celle-ci est une URL déclarée que le gate de
-- prod refuse de croire tant qu'un déploiement ne l'a pas vérifiée
-- (`deploy/prod-gate.ts::resolveStaging`). Celui-là est le domaine du projet,
-- l'adresse que le client tape.
alter table projects add column domaine text;

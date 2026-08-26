-- Où chaque projet se déploie, cible par cible.
--
-- ## Une configuration GLOBALE, pour tous les projets
--
-- Le staging réel était réglé par quatre réglages uniques (`deploy.ssh.host`,
-- `deploy.ssh.user`, `deploy.ssh.root`, `deploy.staging_domain`) et une seule
-- clé de coffre. Un serveur, un domaine joker, `<slug>.<domaine>` pour tout le
-- monde.
--
-- Ça ne survit pas au premier client hébergé ailleurs. Et ça ne permet pas de
-- déclarer une PROD, qui n'existait comme cible d'aucune façon.
--
-- ## Une ligne par (projet, cible)
--
-- Deux au maximum, et souvent une seule : un projet peut n'avoir qu'un
-- staging, n'avoir qu'une prod (un jetable, un site interne), ou les deux. Une
-- table plutôt que des colonnes sur `projects` parce que chaque cible porte
-- quatre champs et que les deux ne se remplissent pas en même temps.
--
-- Le staging SURVIT à la mise en prod. C'est ce qui permet de ne pas prendre
-- de risque : on pousse sur le staging, le juge y passe, et la promotion est
-- un second geste sur du code déjà vu tourner.
create table cibles_deploiement (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,

  cible text not null check (cible in ('staging', 'prod')),

  -- Le serveur porte l'hôte, l'utilisateur, le port, le type d'hébergement et
  -- l'accès au coffre (`ops.<nom>.ssh_private_key`). On ne recopie rien ici :
  -- une seconde source de vérité divergerait au premier changement d'IP.
  --
  -- `restrict` et non `cascade` : supprimer un serveur sur lequel un projet
  -- déploie doit ÉCHOUER bruyamment. Un `cascade` effacerait la configuration
  -- de déploiement d'un projet vivant sans que personne ne le demande.
  serveur_id uuid not null references serveurs(id) on delete restrict,

  -- Le répertoire de destination sur ce serveur. Absolu.
  chemin text not null,
  -- La branche déployée. `main` pour une prod ; un staging suit la branche du
  -- run, ce que le code décide, pas cette colonne.
  branche text not null default 'main',
  -- L'URL publique de CETTE cible. Distincte de `projects.domaine`, qui est
  -- l'adresse du projet : un staging a la sienne, et elle n'est pas celle que
  -- le client tape.
  domaine text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Une seule configuration par cible et par projet. Deux `staging` sur le
  -- même projet rendraient le déploiement non déterministe.
  unique (project_id, cible)
);

create index cibles_deploiement_serveur_idx on cibles_deploiement (serveur_id);

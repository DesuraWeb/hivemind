-- De quel genre d'hébergement il s'agit, et à qui il appartient.
--
-- ## Le catalogue actuel suppose un VPS, sans le dire
--
-- Quatre des six opérations sont IMPOSSIBLES sur du mutualisé :
--   · `installer_paquet`      — pas d'apt
--   · `activer_extension_php` — c'est un panneau, pas un fichier
--   · `recharger_service`     — pas de systemctl
--   · `poser_cron`            — le panneau, le plus souvent
--
-- La colonne `sudo` (migration 0013) modélise « on préfixe la commande ou
-- pas ». Elle ne dit rien du fait que le geste n'existe pas. Un agent qui
-- propose `installer_paquet` sur un mutualisé propose un plan qui ne peut pas
-- s'exécuter — et le découvrir à l'exécution coûte un aller-retour de
-- validation humaine pour rien.
--
-- ## `vps` par défaut, et c'est le bon défaut
--
-- Tous les serveurs déjà déclarés sont des VPS : c'est le seul cas que le
-- produit savait traiter. Un serveur dont personne n'a déclaré le type garde
-- exactement le comportement qu'il avait — l'inverse (supposer du mutualisé)
-- retirerait en silence quatre opérations à des serveurs qui les utilisent.
alter table serveurs
  add column type_hebergement text not null default 'vps'
    check (type_hebergement in ('vps', 'mutualise'));

-- L'hébergeur nommé, quand on le connaît : `planethoster`, `o2switch`, `ovh`.
--
-- Sert de niveau le plus précis dans la cascade de mémoire (migration 0016) :
-- « Astro chez PlanetHoster demande de monter PHP » n'est vrai ni pour Astro
-- en général, ni pour tout le mutualisé. Deux mutualisés ne se ressemblent
-- pas — versions, chemins, panneaux et limites diffèrent.
--
-- Normalisé en minuscules par l'application, jamais par la base : la
-- contrainte serait invisible à la lecture du code qui écrit.
alter table serveurs add column hebergeur text;

-- À qui appartient cet hébergement.
--
-- `serveurs` était un parc plat : on ne pouvait pas répondre à « où vit ce
-- client », qui est la question la plus banale qu'on posera à l'agent
-- d'exploitation.
--
-- Nullable, parce que les serveurs de Florian ne sont à personne. Et
-- `on delete set null` plutôt que `cascade` : supprimer une fiche client ne
-- doit jamais faire disparaître un serveur qui, lui, existe toujours et
-- continue de servir des sites.
alter table serveurs
  add column client_id uuid references clients(id) on delete set null;

create index serveurs_client_idx on serveurs (client_id) where client_id is not null;

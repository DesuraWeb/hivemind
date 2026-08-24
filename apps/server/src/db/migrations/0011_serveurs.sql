-- Les serveurs auxquels l'agent d'exploitation parle (Phase 6).
--
-- ## L'axe qui décide de tout
--
-- Ce n'est pas à qui appartient le serveur qui détermine l'autonomie de
-- l'agent, c'est CE QU'IL Y A DÉJÀ DESSUS. Arbitrage de Florian, 14/08.
--
--   'vierge'     — rien ne répond, aucune donnée, aucun trafic. Champ libre :
--                  il n'y a rien à casser, le risque est nul par construction.
--   'en_service' — un site répond, il y a des données. L'agent propose, un
--                  humain valide, Silithid applique.
--
-- ## Trois choses que ce schéma rend vraies, pas seulement recommandées
--
-- 1. **L'état par défaut est 'inconnu', jamais 'vierge'.** Un serveur qu'on
--    vient d'enregistrer n'a pas encore été mesuré. Le défaut le plus
--    dangereux serait 'vierge' : il donnerait le champ libre à la simple
--    faveur d'un oubli.
--
-- 2. **'vierge' se MESURE, il ne se déclare pas.** `etat_mesure_at` et
--    `etat_preuves` sont obligatoires dès que l'état n'est plus 'inconnu' :
--    la contrainte `serveurs_etat_mesure` refuse un état posé sans preuve.
--    Quelqu'un qui affirmerait qu'un hébergement est vide alors qu'il ne l'est
--    pas détruirait un site client ; c'est la sonde qui tranche.
--
-- 3. **Un serveur n'est vierge qu'une fois.** Le passage à 'en_service' est à
--    sens unique, garanti par le trigger `serveurs_etat_sens_unique`. Sans
--    lui, il suffirait de vider un répertoire pour retrouver le champ libre.
create table serveurs (
  id uuid primary key default gen_random_uuid(),

  -- Nom court et stable. Il sert AUSSI de préfixe de clé dans le coffre
  -- (`ops.<nom>.ssh_private_key`, cf. `ops/credentials.ts`) : un jeu d'accès
  -- par serveur, jamais un accès unique qui ouvrirait tout le parc.
  nom text not null unique,

  hote text not null,
  utilisateur text not null,
  port integer not null default 22,

  -- URL publique à sonder, quand on la connaît. Sans elle, la sonde perd une
  -- preuve — et perdre une preuve fait pencher vers 'en_service', jamais vers
  -- le champ libre.
  url text,

  etat text not null default 'inconnu'
    check (etat in ('inconnu', 'vierge', 'en_service')),
  etat_mesure_at timestamptz,
  -- Ce que la sonde a réellement constaté, preuve par preuve. Relu par l'écran
  -- et par le juge : un verdict sans ses preuves ne se conteste pas.
  etat_preuves jsonb not null default '[]'::jsonb,

  notes text,
  created_at timestamptz not null default now(),

  constraint serveurs_etat_mesure
    check (etat = 'inconnu' or etat_mesure_at is not null)
);

-- Le sens unique. Écrit en trigger et pas en règle applicative : le contrat
-- dit « dès qu'un déploiement y a eu lieu, il passe en service DÉFINITIVEMENT »,
-- et une règle qui vit dans du TypeScript se contourne avec un `update`.
create or replace function serveurs_etat_sens_unique() returns trigger as $$
begin
  if old.etat = 'en_service' and new.etat <> 'en_service' then
    raise exception 'serveur %: un serveur en service ne redevient jamais vierge (état demandé : %)',
      old.nom, new.etat;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger serveurs_etat_sens_unique
  before update on serveurs
  for each row execute function serveurs_etat_sens_unique();

create index serveurs_etat_idx on serveurs (etat);

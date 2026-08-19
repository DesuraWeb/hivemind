-- L'emprunt de savoir entre globes (spec §05).
--
-- Les globes sont ÉTANCHES par défaut. Quand un agent d'un globe a besoin
-- d'un savoir d'un autre, il ne le lit pas : il demande un emprunt, qui passe
-- par l'inbox comme tout le reste.
--
-- Deux issues, et elles n'ont pas la même durée de vie :
--   'lecture'  — le globe emprunteur voit le savoir du prêteur. Il suit ses
--                corrections, et disparaît si l'emprunt est révoqué.
--   'fork'     — une COPIE indépendante est archivée chez l'emprunteur. Elle
--                survit à la révocation et suit sa propre vie. C'est un choix
--                différent, pas une variante : on cesse de partager une
--                vérité, on en prend une photo.
--
-- Ce que cette table NE PEUT PAS porter, et c'est structurel : une fiche
-- client ou un secret. `savoir_racine_id` référence `savoirs`, et ni les
-- fiches clients ni le coffre n'y vivent. L'impossibilité est dans le schéma,
-- pas dans une vérification qu'on pourrait oublier d'écrire.
create table emprunts_savoir (
  id uuid primary key default gen_random_uuid(),

  -- Le globe qui emprunte, et celui qui prête.
  globe_emprunteur_id uuid not null references globes(id) on delete cascade,
  globe_preteur_id uuid not null references globes(id) on delete cascade,

  -- Le savoir emprunté, par sa racine : l'emprunt suit les corrections du
  -- prêteur, il ne fige pas une version.
  savoir_racine_id uuid not null,

  mode text not null check (mode in ('lecture', 'fork')),
  etat text not null default 'actif' check (etat in ('actif', 'revoque')),

  -- Qui a demandé, et pourquoi. Tracé (spec §05).
  demande_par_run_id uuid references runs(id) on delete set null,
  motif text,

  created_at timestamptz not null default now(),
  revoked_at timestamptz,

  -- Un globe n'emprunte rien à lui-même : ses propres savoirs lui sont déjà
  -- rappelés par la cascade.
  constraint emprunt_pas_a_soi_meme check (globe_emprunteur_id <> globe_preteur_id)
);

-- Un même savoir ne s'emprunte qu'une fois par globe, tant que c'est actif.
create unique index emprunts_unicite on emprunts_savoir (globe_emprunteur_id, savoir_racine_id)
  where etat = 'actif';

-- Le rappel cherche ce qu'un globe a le droit de voir en plus du sien.
create index emprunts_rappel_idx on emprunts_savoir (globe_emprunteur_id, etat);

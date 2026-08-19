-- La conscience collective : trois cercles de mémoire, versionnés.
--
-- Cercles, du plus spécifique au plus général (spec §01) :
--   projet → client → globe → hive
-- Le rappel les parcourt dans cet ordre et le plus spécifique gagne. `hive`
-- est le cercle racine : préférences transverses, arbitrages, patterns —
-- jamais de secrets clients.
--
-- VERSIONNÉ, jamais écrasé. Corriger un savoir crée une version ; la
-- précédente reste lisible. C'est ce qui rend une révocation possible, et
-- c'est ce que le pack affiche (v1, v2). Les versions d'un même savoir
-- partagent `racine_id` ; une seule est `actif` à la fois.
--
-- `sujet` porte la détection de conflit (arbitrage du 15/08) : deux savoirs
-- actifs de même sujet dans le même cercle se contredisent probablement. C'est
-- déterministe et gratuit, contre un appel de modèle par proposition — et
-- imparfait, ce que l'item de conflit doit dire.
create table savoirs (
  id uuid primary key default gen_random_uuid(),
  racine_id uuid not null,
  version int not null default 1,

  cercle text not null check (cercle in ('projet', 'client', 'globe', 'hive')),
  -- Null pour le cercle `hive`, qui n'a pas d'instance : il est unique.
  cercle_id uuid,

  sujet text not null,
  contenu md not null,
  -- Stack concernée, quand le savoir en vise une (`laravel`, `wordpress`…).
  -- C'est ce qui rendra `hive.stack_rules` vivant (Task 6).
  stack text,

  etat text not null default 'actif' check (etat in ('actif', 'archive')),
  -- Score d'utilité : incrémenté à chaque rappel. « jamais rappelée » est une
  -- information, pas une absence de donnée.
  rappels int not null default 0,

  origine_run_id uuid references runs(id) on delete set null,
  origine_item_id uuid references inbox_items(id) on delete set null,

  created_at timestamptz not null default now(),
  archived_at timestamptz,

  -- Un savoir de cercle `hive` n'a pas d'instance ; les autres en ont une.
  constraint savoirs_cercle_id_coherent check (
    (cercle = 'hive' and cercle_id is null) or (cercle <> 'hive' and cercle_id is not null)
  )
);

-- Une seule version active par savoir : l'invariant qui rend le rappel
-- déterministe. Un index partiel plutôt qu'une contrainte applicative — deux
-- écritures concurrentes ne peuvent pas produire deux actifs.
create unique index savoirs_une_version_active on savoirs (racine_id) where etat = 'actif';

-- Le rappel filtre sur cercle + instance + état : c'est le chemin chaud.
create index savoirs_rappel_idx on savoirs (cercle, cercle_id, etat);
-- La détection de conflit cherche un sujet dans un cercle.
create index savoirs_sujet_idx on savoirs (cercle, cercle_id, sujet) where etat = 'actif';
-- La revue de péremption trie par utilité puis par âge.
create index savoirs_revue_idx on savoirs (rappels, created_at) where etat = 'actif';

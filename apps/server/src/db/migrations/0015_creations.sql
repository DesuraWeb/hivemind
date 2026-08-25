-- La conversation de création : Hive arme une orbe, puis un premier projet.
--
-- ## Pourquoi une table à elle
--
-- L'écran de Création rejouait une conversation préscriptée — cinq
-- `setTimeout` et un bouton « rejouer ». Elle devient un vrai échange, et un
-- échange payé à un modèle ne doit pas disparaître parce qu'un onglet s'est
-- fermé.
--
-- Deux tables existantes ont été écartées. `messages` est le bus inter-agents
-- (`run_id`) et porte déjà la conversation du bandeau HiveStrip avec
-- `run_id = null` : y loger la création polluerait ce fil-là.
-- `agent_sessions` est attachée à un run, et une création n'en a pas.
--
-- ## Une table, et le fil en JSON
--
-- Dix à trente tours par création. Réécrire la ligne à chaque tour coûte moins
-- qu'une seconde table qu'on n'interrogerait jamais par message. Si un jour on
-- veut chercher DANS les conversations passées, on éclatera — aujourd'hui ce
-- serait une table pour rien.
--
-- ## `fiche` et `conversation` séparées
--
-- Elles changent à des rythmes différents, et surtout les corrections
-- manuelles de Florian n'écrivent que dans `fiche` : réécrire ce que Hive a
-- dit parce qu'on a corrigé un nom de dépôt serait une falsification.
--
-- ## Pas de `session_id`
--
-- `askHive` rejoue l'historique depuis la base à chaque tour au lieu d'utiliser
-- `resume`. On suit ce motif éprouvé : un rafraîchissement reprend la
-- conversation sans machinerie, et une session SDK morte n'emporte rien.
create table creations (
  id uuid primary key default gen_random_uuid(),

  -- Le brouillon courant : identité, steps, roster, mémoire proposée.
  fiche jsonb not null default '{}'::jsonb,
  -- Le fil, en ordre. `[{ de: 'hive' | 'florian', texte, a }]`.
  conversation jsonb not null default '[]'::jsonb,

  -- `en_cours` par défaut. Sans statut, une création abandonnée (trois tours
  -- puis un onglet fermé) resterait vivante pour toujours et personne ne le
  -- saurait.
  statut text not null default 'en_cours'
    check (statut in ('en_cours', 'aboutie', 'abandonnee')),

  -- Ce que cette conversation a créé. Deux colonnes, pas une trace textuelle :
  -- c'est ce qui rend « annuler cette création » trivial, et c'est ce qui rend
  -- acceptable qu'un agent écrive sans demander de confirmation.
  globe_id uuid references globes(id) on delete set null,
  project_id uuid references projects(id) on delete set null,

  -- Les jetons dépensés ici. `agent_sessions.cost_tokens` ne peut pas les
  -- porter (elle est attachée à un run) : sans cette colonne, une conversation
  -- d'architecte avec recherche web serait une dépense invisible au budget.
  cost_tokens bigint not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- L'écran ouvre toujours la création en cours la plus récente.
create index creations_statut_idx on creations (statut, updated_at desc);

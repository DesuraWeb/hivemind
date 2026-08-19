-- La revue de péremption : ce que « toujours vrai · garder » écrit.
--
-- Le geste « garder » ne peut pas être un passe. Sans écriture, un savoir
-- confirmé remonterait en tête de la revue suivante EXACTEMENT comme avant
-- (le tri est piloté par `rappels`, que confirmer ne change pas), et l'écran
-- rendrait la même file après un rechargement : un bouton qui ne fait rien
-- d'observable.
--
-- Trois écritures possibles ont été écartées :
--   · incrémenter `rappels` — ce compteur est le score d'UTILITÉ, écrit par le
--     rappel réel (`recall.ts`). Une confirmation humaine n'est pas un rappel :
--     la falsifier ferait mentir « × 12 rappels » et « jamais rappelée ».
--   · créer une version identique via `corriger()` — un `v2` qui ne dit rien de
--     neuf pollue l'historique, qui existe pour relire ce qui a CHANGÉ.
--   · ne rien écrire — cf. ci-dessus.
--
-- Reste la seule information que le geste porte réellement : la date à
-- laquelle un humain a dit « c'est encore vrai ». C'est aussi ce qui rend la
-- revue finie — un savoir confirmé sort de la file pour un trimestre, les
-- non-traités restent — et ce qui permet à l'écran de ne rien promettre :
-- personne ne planifie ni ne prévient, cette colonne dit seulement quand la
-- dernière confirmation a eu lieu.
alter table savoirs add column revue_at timestamptz;

-- Pas d'index nouveau : le tri de la revue reste (rappels, created_at) — jamais
-- rappelé d'abord, puis les plus anciens — et `savoirs_revue_idx` le couvre
-- déjà. `revue_at` n'est qu'un filtre appliqué par-dessus.
comment on column savoirs.revue_at is
  'Dernière confirmation humaine en revue de péremption. Null = jamais passé en revue.';

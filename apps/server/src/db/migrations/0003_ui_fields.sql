-- Teinte propre au projet : cluster dans l'orbe, pastille dans les listes.
-- Distincte de globes.color, qui teinte le globe entier.
alter table projects add column tint text;

-- Ligne de synthèse rédigée par Hive (« Le dev itère sereinement · prod du
-- step 3 à valider »). Rédigée, pas calculée : le front ne doit jamais tenter
-- de la reconstituer à partir de l'état.
alter table projects add column synth text;

-- Rôle qui a levé l'item. L'UI l'affiche à côté du titre ; sans lui, on ne
-- peut pas distinguer une question du garant d'une question du dev.
alter table inbox_items add column from_role text;

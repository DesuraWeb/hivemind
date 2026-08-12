-- Technologie du projet (Laravel, PrestaShop, WordPress…). Déclarée à la
-- création, affichée dans les listes et utilisée par Hive pour challenger la
-- stack au cadrage. Absente de l'audit initial de data.js.
alter table projects add column stack text;

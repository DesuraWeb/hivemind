-- L'anti-répétition des propositions de savoir (Phase 7, Task 3).
--
-- Un refus ne doit pas revenir : avant de lever un item « validation ·
-- savoir », `knowledge/propose.ts` cherche si la même empreinte (cercle +
-- instance + sujet normalisé) a déjà été proposée, et se tait si elle a été
-- refusée ou si elle attend encore. La mémoire de ce refus n'est PAS une
-- nouvelle table : `inbox_items` porte déjà `status` et `human_response`,
-- c'est-à-dire la trace permanente et faisant foi de ce que Florian a refusé.
-- Une seconde source de vérité sur la même décision divergerait au premier
-- incident, et ce projet a déjà tranché ce genre de question trois fois.
--
-- Il ne reste donc qu'à rendre cette recherche indexée plutôt que séquentielle
-- : elle tourne à chaque verdict portant un candidat.
create index inbox_savoir_empreinte_idx
  on inbox_items ((payload ->> 'empreinte'))
  where subtype = 'savoir';

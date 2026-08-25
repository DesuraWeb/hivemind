-- Le juge visuel est-il pertinent pour ce projet ?
--
-- Il était obligatoire : quand le garant ne désignait aucune page, `deploying`
-- retombait sur « / » et capturait quand même. Sur un projet SANS interface —
-- une API, une bibliothèque, un script — on payait un navigateur et un échange
-- de modèle pour regarder une page qui n'existe pas.
--
-- Le VPS a ajouté une contrainte plus dure que l'absurdité : Chromium tient
-- ~300 Mo par instance EN PLUS des ~285 Mo de l'agent. Avec trois boucles
-- simultanées, sur une machine qui sert deux applications clientes derrière un
-- `MemoryMax=4G`, c'est de la RAM prise à d'autres.
--
-- `true` par défaut, et c'est important : le juge est le SEUL contrôle qui
-- regarde le résultat plutôt que le code. Le reviewer lit le diff. Un défaut à
-- `false` ferait disparaître ce contrôle par distraction, sur des projets qui
-- en ont besoin.
alter table projects
  add column juge_visuel boolean not null default true;

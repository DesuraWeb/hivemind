-- Globes : espaces de conscience au-dessus des projets (Desura / Perso / R&D).
create table globes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  color text,                       -- teinte du globe dans le système solaire
  position int not null default 0,
  created_at timestamptz not null default now()
);

-- Un globe « Desura » est créé au setup : projects.globe_id est NOT NULL, il
-- faut donc une valeur avant d'ajouter la contrainte.
insert into globes (name, slug, position) values ('Desura', 'desura', 0);

alter table projects add column globe_id uuid references globes(id);
update projects set globe_id = (select id from globes where slug = 'desura');
alter table projects alter column globe_id set not null;
create index projects_globe_idx on projects (globe_id);

-- Où reprendre après une pause budget ou une question bloquante. Une seule
-- colonne couvre les deux cas : on n'est jamais en pause et bloqué à la fois.
alter table runs add column resume_state text;

-- Nombre d'allers-retours dev↔reviewer déjà consommés dans cette itération.
alter table runs add column review_round int not null default 0;

-- Domaine sémantique : du texte destiné à contenir du markdown.
create domain md as text;

-- Utilisateur unique de l'outil (mono-user en v0).
create table users (
  id uuid primary key default gen_random_uuid(),
  login text unique not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  siret text,
  contacts jsonb not null default '[]',
  tone text,
  notes jsonb not null default '[]',      -- {q, a, source_item_id, at}
  secrets jsonb not null default '{}',    -- chiffré applicativement (libsodium)
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id),
  name text not null,
  slug text unique not null,
  repo_full_name text not null,           -- ex: desura/lekoin
  default_branch text not null default 'main',
  staging_url text,
  context md,                             -- contexte produit injecté aux agents
  autonomy_default text not null default 'gated'
    check (autonomy_default in ('gated','auto')),
  budget_weight int not null default 5
    check (budget_weight between 1 and 10),
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table steps (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  position int not null,
  title text not null,
  specs md not null,
  autonomy text check (autonomy in ('gated','auto')),  -- null = hérite du projet
  max_iterations int not null default 4,
  budget_tokens int,
  status text not null default 'pending'
    check (status in ('pending','running','awaiting_human','validated','failed')),
  created_at timestamptz not null default now()
);
create index steps_project_position_idx on steps (project_id, position);

create table role_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null,                      -- majordome|garant|dev|reviewer|judge|communicant
  project_type text not null default 'generic',
  version int not null default 1,
  system_prompt md not null,
  tools jsonb not null,
  model text,
  unique (key, project_type, version)
);

-- Instance par projet : copie éditable d'un template.
create table roles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  template_id uuid references role_templates(id),
  key text not null,
  system_prompt md not null,
  tools jsonb not null,
  model text,
  enabled bool not null default true,
  unique (project_id, key)
);

-- Une boucle.
create table runs (
  id uuid primary key default gen_random_uuid(),
  step_id uuid not null references steps(id) on delete cascade,
  iteration int not null default 1,
  state text not null default 'framing' check (state in
    ('framing','coding','design_wait','reviewing','deploying','judging','verdict',
     'awaiting_human','done','failed','paused_budget')),
  branch text,
  pr_number int,
  worktree_path text,
  cost_tokens bigint not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index runs_step_idx on runs (step_id);
create index runs_state_idx on runs (state);

create table agent_sessions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete cascade,
  role_key text not null,
  sdk_session_id text,
  state text not null default 'idle',
  cost_tokens bigint not null default 0,
  created_at timestamptz not null default now()
);
create index agent_sessions_run_idx on agent_sessions (run_id);

-- Bus inter-agents : persisté = piste d'audit.
create table messages (
  id bigint generated always as identity primary key,
  run_id uuid references runs(id) on delete cascade,
  from_role text not null,
  to_role text not null,
  kind text not null,                     -- prompt|report|question|correction|info
  body md not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index messages_run_created_idx on messages (run_id, created_at);

create table inbox_items (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('question','approval','handoff','verdict','alert','info')),
  subtype text,                           -- approval: email|prod|step_end
  project_id uuid references projects(id) on delete cascade,
  run_id uuid references runs(id) on delete cascade,
  title text not null,
  payload jsonb not null,
  status text not null default 'open' check (status in ('open','done','dismissed')),
  human_response jsonb,
  created_at timestamptz not null default now(),
  blocked_since timestamptz not null default now(),
  resolved_at timestamptz,
  archive_to_client bool not null default true
);
create index inbox_items_open_idx on inbox_items (status, created_at desc);

-- Suivi de consommation du compte Claude.
create table usage_windows (
  id bigint generated always as identity primary key,
  window_kind text not null check (window_kind in ('5h','7d')),
  used_pct numeric,
  raw jsonb,
  sampled_at timestamptz not null default now()
);
create index usage_windows_sampled_idx on usage_windows (sampled_at desc);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete cascade,
  kind text not null,                     -- screenshot|judge_report|diff
  path text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index artifacts_run_idx on artifacts (run_id);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

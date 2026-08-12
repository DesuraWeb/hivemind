import type { AutonomyMode, InboxStatus, InboxType, RunState } from '@chapo/shared'
import type { ColumnType, Generated, JSONColumnType } from 'kysely'

/** Colonne écrite par la DB (default now()), jamais fournie à l'insert. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>

export interface UsersTable {
  id: Generated<string>
  login: string
  password_hash: string
  created_at: Generated<Timestamp>
}

export interface ClientsTable {
  id: Generated<string>
  name: string
  siret: string | null
  /** `not null default '[]'` : optionnel à l'insert, la DB fournit le défaut. */
  contacts: ColumnType<unknown[], string | undefined, string>
  tone: string | null
  /** `not null default '[]'` : optionnel à l'insert, la DB fournit le défaut. */
  notes: ColumnType<unknown[], string | undefined, string>
  /** `not null default '{}'` : optionnel à l'insert, la DB fournit le défaut. */
  secrets: ColumnType<Record<string, unknown>, string | undefined, string>
  created_at: Generated<Timestamp>
}

export interface ProjectsTable {
  id: Generated<string>
  client_id: string | null
  name: string
  slug: string
  repo_full_name: string
  default_branch: Generated<string>
  staging_url: string | null
  context: string | null
  autonomy_default: Generated<AutonomyMode>
  budget_weight: Generated<number>
  status: Generated<string>
  created_at: Generated<Timestamp>
}

export interface StepsTable {
  id: Generated<string>
  project_id: string
  position: number
  title: string
  specs: string
  autonomy: AutonomyMode | null
  max_iterations: Generated<number>
  budget_tokens: number | null
  status: Generated<'pending' | 'running' | 'awaiting_human' | 'validated' | 'failed'>
  created_at: Generated<Timestamp>
}

export interface RoleTemplatesTable {
  id: Generated<string>
  key: string
  project_type: Generated<string>
  version: Generated<number>
  system_prompt: string
  tools: JSONColumnType<Record<string, unknown>>
  model: string | null
}

export interface RolesTable {
  id: Generated<string>
  project_id: string
  template_id: string | null
  key: string
  system_prompt: string
  tools: JSONColumnType<Record<string, unknown>>
  model: string | null
  enabled: Generated<boolean>
}

export interface RunsTable {
  id: Generated<string>
  step_id: string
  iteration: Generated<number>
  state: Generated<RunState>
  branch: string | null
  pr_number: number | null
  worktree_path: string | null
  cost_tokens: Generated<string>
  started_at: Generated<Timestamp>
  ended_at: Timestamp | null
}

export interface AgentSessionsTable {
  id: Generated<string>
  run_id: string | null
  role_key: string
  sdk_session_id: string | null
  state: Generated<string>
  cost_tokens: Generated<string>
  created_at: Generated<Timestamp>
}

export interface MessagesTable {
  id: Generated<string>
  run_id: string | null
  from_role: string
  to_role: string
  kind: string
  body: string
  /** `not null default '{}'` : optionnel à l'insert, la DB fournit le défaut. */
  meta: ColumnType<Record<string, unknown>, string | undefined, string>
  created_at: Generated<Timestamp>
}

export interface InboxItemsTable {
  id: Generated<string>
  type: InboxType
  subtype: string | null
  project_id: string | null
  run_id: string | null
  title: string
  payload: JSONColumnType<Record<string, unknown>>
  status: Generated<InboxStatus>
  human_response: JSONColumnType<Record<string, unknown>> | null
  created_at: Generated<Timestamp>
  blocked_since: Generated<Timestamp>
  resolved_at: Timestamp | null
  archive_to_client: Generated<boolean>
}

export interface UsageWindowsTable {
  id: Generated<string>
  window_kind: '5h' | '7d'
  used_pct: string | null
  raw: JSONColumnType<Record<string, unknown>> | null
  sampled_at: Generated<Timestamp>
}

export interface ArtifactsTable {
  id: Generated<string>
  run_id: string | null
  kind: string
  path: string
  /** `not null default '{}'` : optionnel à l'insert, la DB fournit le défaut. */
  meta: ColumnType<Record<string, unknown>, string | undefined, string>
  created_at: Generated<Timestamp>
}

export interface SettingsTable {
  key: string
  // Un réglage peut valoir n'importe quel JSON, y compris un scalaire (70) —
  // pas seulement un objet. D'où `unknown` en lecture plutôt que
  // JSONColumnType, qui contraindrait à `object | null`.
  value: ColumnType<unknown, string, string>
  updated_at: Generated<Timestamp>
}

export interface Database {
  users: UsersTable
  clients: ClientsTable
  projects: ProjectsTable
  steps: StepsTable
  role_templates: RoleTemplatesTable
  roles: RolesTable
  runs: RunsTable
  agent_sessions: AgentSessionsTable
  messages: MessagesTable
  inbox_items: InboxItemsTable
  usage_windows: UsageWindowsTable
  artifacts: ArtifactsTable
  settings: SettingsTable
}

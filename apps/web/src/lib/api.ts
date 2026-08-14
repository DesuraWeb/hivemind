import type { InboxStatus, InboxType } from '@silithid/shared'
import type {
  InboxItemView,
  InboxResponsePayload,
  OptimizeAnswerResult,
  ResolveResult,
} from './inbox-types'
import type { ProjectView, RunView, StepView } from './project-types'

/**
 * Un champ refusé par la validation du serveur : `POST /api/projects` rend
 * `400 { error, details }` où `details` sont les `issues` zod telles quelles
 * (`{ path, message }`). L'écran de création doit pouvoir dire QUEL champ ne
 * va pas — d'où ce transport jusqu'à l'UI plutôt qu'un « ça n'a pas marché ».
 */
export interface ApiErrorDetail {
  /** Chemin du champ fautif, aplati : `name`, `steps.1.specs`… */
  path: string
  message: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: ApiErrorDetail[] = [],
  ) {
    super(message)
  }
}

/** Les `issues` zod sont du JSON non typé : on ne garde que ce qui est lisible. */
function toDetails(raw: unknown): ApiErrorDetail[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): ApiErrorDetail[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const issue = entry as { path?: unknown; message?: unknown }
    if (typeof issue.message !== 'string' || issue.message.length === 0) return []
    const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : ''
    return [{ path, message: issue.message }]
  })
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // `exactOptionalPropertyTypes` interdit d'assigner `undefined` à `headers`/`body`
  // (RequestInit ne les type pas avec `| undefined`) : on omet les clés au lieu de
  // les mettre à `undefined` quand il n'y a pas de corps.
  const res = await fetch(path, {
    method,
    credentials: 'include',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  })
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown }
    throw new ApiError(
      res.status,
      payload.error ?? `HTTP ${res.status}`,
      toDetails(payload.details),
    )
  }
  return (await res.json()) as T
}

export interface Me {
  id: string
  login: string
}

/**
 * Sous-ensemble de `ProjectView` (project-types.ts) dont l'Inbox a besoin :
 * le nom et la teinte du projet pour la ligne de méta d'un item (« Le Koin ·
 * dev · q-112 »). `api.projects.list()` rend la forme complète — le reste des
 * champs (step, loop, conso…) est simplement ignoré ici, pas absent.
 */
export interface ProjectSummary {
  id: string
  name: string
  tint: string | null
}

/**
 * Miroir front de `GlobeView` (apps/server/src/globes/repo.ts). Comme pour
 * les projets, `id` est le slug public. Les compteurs (`projectCount`,
 * `activeCount`, `pendingCount`) sont dérivés côté serveur — jamais
 * recalculés ici.
 */
export interface BudgetGauge {
  /** Pourcentage retenu pour décider : le max des deux fenêtres, majoration comprise. */
  pct: number
  /** `false` quand la mesure est périmée : la jauge s'affiche « inconnu ». */
  known: boolean
  fiveHourPct: number
  sevenDayPct: number
  ageMinutes: number | null
}

export interface BudgetView {
  /** `null` quand le runtime n'expose aucune consommation : afficher « inconnu », jamais un zéro rassurant. */
  gauge: BudgetGauge | null
  reason: string
  resetsAt: string | null
  reserve: { state: 'intacte' | 'entamee'; pct: number; until: string | null }
  thresholds: { pause: number; pauseNominal: number; resume: number }
}

export interface GlobeView {
  id: string
  name: string
  color: string | null
  position: number
  projectCount: number
  activeCount: number
  pendingCount: number
}

export interface CreateGlobeInput {
  name: string
  color?: string
}

/**
 * Un step à la création (`POST /api/projects`). `specs` est obligatoire côté
 * serveur : un step sans specs serait un step qu'aucun agent ne peut prendre.
 * `autonomy` ne porte QUE sur l'itération dev↔reviewer — la mise en prod reste
 * un gate quelle que soit sa valeur.
 */
export interface CreateProjectStepInput {
  title: string
  specs: string
  autonomy?: 'gated' | 'auto'
  maxIterations?: number
}

/**
 * Corps de `POST /api/projects`. `globe` est le slug du globe d'accueil, et
 * `repoFullName` (`owner/nom`) désigne un dépôt qui doit **déjà exister** :
 * le serveur enregistre un projet, il ne crée aucun dépôt.
 */
export interface CreateProjectInput {
  globe: string
  name: string
  repoFullName: string
  clientId?: string
  stack?: string
  tint?: string
  stagingUrl?: string
  steps?: CreateProjectStepInput[]
}

export interface CreatedProject {
  id: string
  slug: string
  name: string
  globeSlug: string
  stepCount: number
}

/**
 * Sous-ensemble de `ClientView` (apps/server/src/clients/repo.ts) dont l'écran
 * de création a besoin : de quoi remplir un menu déroulant. `id` est l'UUID de
 * la fiche — c'est lui que `POST /api/projects` attend en `clientId`. Même
 * parti que `ProjectSummary` : les autres champs sont ignorés, pas absents.
 */
export interface ClientSummary {
  id: string
  name: string
}

/** Miroir front de `RoleTemplateView` (apps/server/src/api/routes/roles.ts). */
export interface RoleTemplateView {
  key: string
  projectType: string
  version: number
  model: string | null
  usedByProjects: number
  /** Toujours `null` : la table n'a aucune colonne d'horodatage (cf. serveur). */
  modifiedAt: null
}

export interface InboxListFilters {
  status?: InboxStatus
  type?: InboxType
  project?: string
}

function toQuery(filters: InboxListFilters): string {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.type) params.set('type', filters.type)
  if (filters.project) params.set('project', filters.project)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  login: (login: string, password: string) =>
    request<Me>('POST', '/api/auth/login', { login, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  inbox: {
    list: (filters: InboxListFilters = {}) =>
      request<InboxItemView[]>('GET', `/api/inbox${toQuery(filters)}`),
    resolve: (id: string, response: InboxResponsePayload) =>
      request<ResolveResult>('POST', `/api/inbox/${id}/resolve`, { response }),
    /** À la demande uniquement (bouton « Optimiser ») — jamais appelé à la frappe. */
    optimize: (id: string, text: string) =>
      request<OptimizeAnswerResult>('POST', `/api/inbox/${id}/optimize`, { text }),
  },
  projects: {
    list: () => request<ProjectView[]>('GET', '/api/projects'),
    /**
     * Projets d'un seul globe (écran « intérieur de globe »). Signature
     * distincte de `list()` plutôt qu'un paramètre optionnel : `list` est
     * passée telle quelle en `queryFn` par Dashboard et CommandPalette, et
     * React Query appelle `queryFn(context)` — un paramètre de filtre y
     * recevrait le contexte de la requête, pas un filtre.
     *
     * Le filtrage est fait par le serveur (`?globe=`) : un globe peut porter
     * 100+ projets, les charger tous pour en jeter la majorité serait payer
     * la liste complète à chaque entrée dans un globe.
     */
    byGlobe: (globe: string) =>
      request<ProjectView[]>('GET', `/api/projects?globe=${encodeURIComponent(globe)}`),
    get: (id: string) => request<ProjectView>('GET', `/api/projects/${encodeURIComponent(id)}`),
    steps: (id: string) =>
      request<StepView[]>('GET', `/api/projects/${encodeURIComponent(id)}/steps`),
    runs: (id: string) => request<RunView[]>('GET', `/api/projects/${encodeURIComponent(id)}/runs`),
    /**
     * Crée un projet et ses steps · rien d'autre. Aucun dépôt GitHub n'est
     * créé, aucun staging n'est provisionné, aucun accès n'est déposé dans le
     * coffre (cf. `apps/server/src/projects/create.ts`) : l'écran de création
     * ne doit rien promettre de plus.
     */
    create: (input: CreateProjectInput) => request<CreatedProject>('POST', '/api/projects', input),
  },
  clients: {
    list: () => request<ClientSummary[]>('GET', '/api/clients'),
  },
  roleTemplates: {
    list: () => request<RoleTemplateView[]>('GET', '/api/role-templates'),
  },
  budget: {
    /**
     * La mesure est gratuite côté serveur (`runtime/usage.ts` interroge le SDK
     * sans consommer de token) : cette route peut être rafraîchie sans coût.
     */
    get: () => request<BudgetView>('GET', '/api/budget'),
  },
  globes: {
    list: () => request<GlobeView[]>('GET', '/api/globes'),
    create: (input: CreateGlobeInput) => request<GlobeView>('POST', '/api/globes', input),
  },
}

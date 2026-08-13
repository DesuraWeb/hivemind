import type { InboxStatus, InboxType } from '@silithid/shared'
import type {
  InboxItemView,
  InboxResponsePayload,
  OptimizeAnswerResult,
  ResolveResult,
} from './inbox-types'
import type { ProjectView, RunView, StepView } from './project-types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
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
    const payload = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, payload.error ?? `HTTP ${res.status}`)
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
  },
  globes: {
    list: () => request<GlobeView[]>('GET', '/api/globes'),
    create: (input: CreateGlobeInput) => request<GlobeView>('POST', '/api/globes', input),
  },
}

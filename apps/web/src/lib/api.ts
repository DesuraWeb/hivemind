import type { InboxStatus, InboxType } from '@silithid/shared'
import type { InboxItemView, InboxResponsePayload, ResolveResult } from './inbox-types'

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
 * Sous-ensemble de `ProjectView` (projects/repo.ts) dont l'Inbox a besoin :
 * le nom et la teinte du projet pour la ligne de méta d'un item (« Le Koin ·
 * dev · q-112 »). `api.projects.list()` rend la forme complète — le reste des
 * champs (step, loop, conso…) est simplement ignoré ici, pas absent.
 */
export interface ProjectSummary {
  id: string
  name: string
  tint: string | null
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
  },
  projects: {
    list: () => request<ProjectSummary[]>('GET', '/api/projects'),
  },
}

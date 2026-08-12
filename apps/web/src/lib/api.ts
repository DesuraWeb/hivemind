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

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  login: (login: string, password: string) =>
    request<Me>('POST', '/api/auth/login', { login, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
}

import { type FormEvent, useState } from 'react'
import { ApiError, api } from '../lib/api'
import type { Me } from '../lib/api'

export function Login({ onSuccess }: { onSuccess: (me: Me) => void }) {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      onSuccess(await api.login(login, password))
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Identifiants invalides.'
          : 'Connexion impossible.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{ maxWidth: 320, margin: '15vh auto', display: 'grid', gap: 12 }}
    >
      <h1 style={{ margin: 0, fontSize: 20 }}>chapo</h1>
      <input
        aria-label="Identifiant"
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        autoComplete="username"
        placeholder="Identifiant"
      />
      <input
        aria-label="Mot de passe"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        placeholder="Mot de passe"
      />
      <button type="submit" disabled={pending || !login || !password}>
        {pending ? 'Connexion…' : 'Se connecter'}
      </button>
      {error && <p style={{ color: 'var(--hm-danger)', margin: 0 }}>{error}</p>}
    </form>
  )
}

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

  const inputStyle = {
    background: 'var(--bg-2)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--r-md)',
    padding: '10px 14px',
    font: '500 13.5px var(--font-sans)',
    color: 'var(--text-hi)',
    outline: 'none',
  } as const

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-0)',
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: 320,
          display: 'grid',
          gap: 14,
          padding: 28,
          borderRadius: 'var(--r-lg)',
          background: 'var(--glass-bg)',
          border: '1px solid var(--glass-border)',
        }}
      >
        <h1
          style={{
            margin: 0,
            font: '600 var(--fs-h3) var(--font-sans)',
            color: 'var(--text-hi)',
          }}
        >
          Silithid
        </h1>
        <input
          aria-label="Identifiant"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          autoComplete="username"
          placeholder="Identifiant"
          style={inputStyle}
        />
        <input
          aria-label="Mot de passe"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          placeholder="Mot de passe"
          style={inputStyle}
        />
        <button
          type="submit"
          disabled={pending || !login || !password}
          style={{
            background: 'var(--accent)',
            color: 'var(--accent-ink)',
            border: 'none',
            borderRadius: 'var(--r-md)',
            padding: '10px 14px',
            font: '600 13.5px var(--font-sans)',
            cursor: pending || !login || !password ? 'default' : 'pointer',
            opacity: pending || !login || !password ? 0.6 : 1,
          }}
        >
          {pending ? 'Connexion…' : 'Se connecter'}
        </button>
        {error && (
          <p style={{ color: 'var(--sem-alert)', font: '500 12.5px var(--font-sans)', margin: 0 }}>
            {error}
          </p>
        )}
      </form>
    </div>
  )
}

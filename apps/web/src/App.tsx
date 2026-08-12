import { useEffect, useState } from 'react'
import { api } from './lib/api'
import type { Me } from './lib/api'
import { Login } from './routes/Login'

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setChecked(true))
  }, [])

  if (!checked) return null
  if (!me) return <Login onSuccess={setMe} />

  return (
    <main style={{ padding: 24 }}>
      <p>Connecté en tant que {me.login}.</p>
      <button
        type="button"
        onClick={() => {
          void api.logout().then(() => setMe(null))
        }}
      >
        Se déconnecter
      </button>
    </main>
  )
}

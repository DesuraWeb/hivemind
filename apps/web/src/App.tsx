import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import type { Me } from './lib/api'
import { AuthContext } from './lib/auth-context'
import { router } from './router'
import { Login } from './routes/Login'

const queryClient = new QueryClient()

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

  function logout() {
    void api.logout().then(() => setMe(null))
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{ me, logout }}>
        <RouterProvider router={router} />
      </AuthContext.Provider>
    </QueryClientProvider>
  )
}

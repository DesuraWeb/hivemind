import { createContext, useContext } from 'react'
import type { Me } from './api'

export interface AuthContextValue {
  me: Me
  logout: () => void
}

// Contexte React (pas le contexte du routeur) : l'utilisateur connecté et la
// déconnexion doivent être lisibles depuis n'importe quelle page sans
// re-router App.tsx à chaque écran qui en a besoin (rail nav pour l'instant,
// HiveStrip plus tard).
export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error('useAuth doit être appelé sous AuthContext.Provider (utilisateur connecté).')
  }
  return value
}

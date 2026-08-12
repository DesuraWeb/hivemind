import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { Layout } from './components/Layout'
import { Clients } from './routes/Clients'
import { Dashboard } from './routes/Dashboard'
import { Globes } from './routes/Globes'
import { Inbox } from './routes/Inbox'
import { Reglages } from './routes/Reglages'

// Routage code-first (pas de génération de fichiers de routes) : cinq routes
// posées par la Task 6, quatre d'entre elles restent des pages vides pour
// l'instant — c'est la navigation qu'on pose, pas les écrans (Tasks 7 et 8).
const rootRoute = createRootRoute({ component: Layout })

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Dashboard,
})

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: Inbox,
})

const globesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/globes',
  component: Globes,
})

const clientsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/clients',
  component: Clients,
})

const reglagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reglages',
  component: Reglages,
})

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  inboxRoute,
  globesRoute,
  clientsRoute,
  reglagesRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

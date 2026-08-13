import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { Layout } from './components/Layout'
import { Clients } from './routes/Clients'
import { Dashboard } from './routes/Dashboard'
import { GlobeInterior } from './routes/GlobeInterior'
import { Globes } from './routes/Globes'
import { Inbox } from './routes/Inbox'
import { Reglages } from './routes/Reglages'

// Routage code-first (pas de génération de fichiers de routes) : cinq routes
// posées par la Task 6, quatre d'entre elles restent des pages vides pour
// l'instant — c'est la navigation qu'on pose, pas les écrans (Tasks 7 et 8).
//
// Les deux routes ajoutées ensuite descendent sous `/globes` parce que le fil
// d'Ariane de CLAUDE.md l'est aussi (« Globes / Desura », puis « Globes /
// Desura / projet ») : l'URL est le chemin de navigation, pas une adresse
// parallèle. `/globes/$globeId` est l'intérieur d'un globe (Projets.dc.html),
// `/globes/$globeId/$projectId` la fiche d'un projet (Projet.dc.html) — le
// slug du globe y reste présent pour que la fiche rende son fil d'Ariane
// sans dépendre d'un chargement.
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

const globeInteriorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/globes/$globeId',
  component: GlobeInterior,
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
  globeInteriorRoute,
  clientsRoute,
  reglagesRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

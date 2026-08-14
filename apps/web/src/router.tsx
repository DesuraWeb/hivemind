import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { Layout } from './components/Layout'
import { Clients } from './routes/Clients'
import { Creation } from './routes/Creation'
import { Dashboard } from './routes/Dashboard'
import { GlobeInterior } from './routes/GlobeInterior'
import { Globes } from './routes/Globes'
import { Inbox } from './routes/Inbox'
import { Project } from './routes/Project'
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

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/globes/$globeId/$projectId',
  component: Project,
})

/**
 * Scène de création (`Creation.dc.html`), à la racine et non sous `/globes`.
 *
 * Elle précède l'existence de ce qu'elle crée : en mode globe, il n'y a aucun
 * `$globeId` sous lequel se ranger, et l'écran commence justement par choisir
 * entre un projet et un globe. Un chemin `/globes/nouveau` mentirait sur les
 * deux tableaux (fil d'Ariane inexistant, moitié des cas hors sujet).
 *
 * Le contexte se porte donc en recherche, pas en segment : `?mode=` préchoisit
 * le script quand l'appelant sait déjà quoi créer (« + Nouveau projet » depuis
 * l'intérieur d'un globe), `?globe=` présélectionne le globe d'accueil. Les
 * deux sont facultatifs — `/creation` nu rend l'écran du pack, avec son choix
 * au centre.
 */
export interface CreationSearch {
  mode?: 'projet' | 'globe'
  globe?: string
}

const creationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/creation',
  // `exactOptionalPropertyTypes` : une clé absente est absente, jamais
  // présente et valant `undefined`.
  validateSearch: (search: Record<string, unknown>): CreationSearch => {
    const mode = search.mode === 'projet' || search.mode === 'globe' ? search.mode : null
    const globe = typeof search.globe === 'string' && search.globe !== '' ? search.globe : null
    return { ...(mode ? { mode } : {}), ...(globe ? { globe } : {}) }
  },
  component: Creation,
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
  projectRoute,
  creationRoute,
  clientsRoute,
  reglagesRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

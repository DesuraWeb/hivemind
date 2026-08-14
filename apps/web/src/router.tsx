import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { Layout } from './components/Layout'
import { Ambient } from './routes/Ambient'
import { Analytics } from './routes/Analytics'
import { Clients } from './routes/Clients'
import { Conscience } from './routes/Conscience'
import { Creation } from './routes/Creation'
import { Dashboard } from './routes/Dashboard'
import { GlobeInterior } from './routes/GlobeInterior'
import { Globes } from './routes/Globes'
import { Inbox } from './routes/Inbox'
import { Journal } from './routes/Journal'
import { Onboarding } from './routes/Onboarding'
import { Project } from './routes/Project'
import { Protocole } from './routes/Protocole'
import { Reglages } from './routes/Reglages'
import { RevueMatin } from './routes/RevueMatin'
import { RunLive } from './routes/RunLive'

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

/**
 * Les écrans restants du pack. Les chemins sont posés ici en une fois, avec
 * des composants encore vides pour certains : plusieurs sessions les
 * remplissent en parallèle, et se partager ce fichier les mettrait en
 * conflit. Une route déclarée avant son écran ne coûte rien ; deux sessions
 * qui réécrivent le même `routeTree` coûtent une résolution manuelle.
 */
const journalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/journal',
  component: Journal,
})

const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/analytics',
  component: Analytics,
})

const runLiveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$runId',
  component: RunLive,
})

const revueMatinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/revue',
  component: RevueMatin,
})

const ambientRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ambient',
  component: Ambient,
})

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: Onboarding,
})

/** Deux pages de spécification, sans état ni API : la mémoire et le pipeline. */
const conscienceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/conscience',
  component: Conscience,
})

const protocoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/protocole',
  component: Protocole,
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
  journalRoute,
  analyticsRoute,
  runLiveRoute,
  revueMatinRoute,
  ambientRoute,
  onboardingRoute,
  conscienceRoute,
  protocoleRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

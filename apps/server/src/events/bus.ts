import { EventEmitter } from 'node:events'

/**
 * Charge minimale (plan Phase 3, Task 3) : un type et des identifiants,
 * jamais l'objet complet. Deux raisons — on ne peut pas diffuser un secret
 * par inadvertance si l'objet n'est jamais mis sur le fil, et le flux reste
 * lisible au `curl -N` quand on le débogue à la main. Le front recharge ce
 * dont il a besoin via l'API REST à réception de l'identifiant.
 */
export interface InboxNewEvent {
  type: 'inbox.new'
  id: string
  projectId: string | null
}

export interface InboxResolvedEvent {
  type: 'inbox.resolved'
  id: string
  projectId: string | null
}

export interface RunStateEvent {
  type: 'run.state'
  runId: string
  projectId: string
}

export interface BudgetTickEvent {
  type: 'budget.tick'
  projectId: string
}

export type BusEvent = InboxNewEvent | InboxResolvedEvent | RunStateEvent | BudgetTickEvent

export type BusListener = (event: BusEvent) => void

export interface EventBus {
  publish(event: BusEvent): void
  /** Retourne la fonction de désabonnement — l'appelant DOIT la garder et l'invoquer à la fermeture. */
  subscribe(listener: BusListener): () => void
  /** Nombre d'abonnés courants. Sert uniquement à prouver l'absence de fuite en test. */
  subscriberCount(): number
}

// Canal interne unique de l'émetteur : le type de l'événement voyage dans le
// payload (`event.type`), pas dans le nom du canal EventEmitter.
const CHANNEL = 'event'

export function createEventBus(): EventBus {
  const emitter = new EventEmitter()
  // Un abonné par connexion SSE ouverte : plusieurs dizaines en usage normal.
  // Le plafond par défaut de Node (10) déclencherait un warning "possible
  // memory leak" qui n'en est pas un — désactivé plutôt que masqué.
  emitter.setMaxListeners(0)

  return {
    publish(event) {
      emitter.emit(CHANNEL, event)
    },
    subscribe(listener) {
      emitter.on(CHANNEL, listener)
      return () => emitter.off(CHANNEL, listener)
    },
    subscriberCount() {
      return emitter.listenerCount(CHANNEL)
    },
  }
}

/**
 * Singleton importé directement par les producteurs (orchestrateur, inbox)
 * et par la route SSE, plutôt qu'injecté en dépendance explicite.
 *
 * Justification : le bus est un canal in-memory sans état à gérer (pas de
 * connexion à ouvrir/fermer, pas de configuration par environnement,
 * contrairement à `db` ou `boss`) et sans callers hors process — l'injecter
 * ferait remonter un paramètre supplémentaire dans `applyEvent`,
 * `createInboxItem` et `resolveInboxItem`, jusque dans tous leurs appelants
 * (jobs, scripts, tests) qui n'ont rien à dire sur la diffusion SSE. Le
 * fichier `loop/bus.ts` (piste d'audit `messages`, un bus différent malgré le
 * nom voisin) suit déjà cette convention : `appendMessage` est importé
 * directement par l'orchestrateur, jamais passé en paramètre. Ce module fait
 * pareil.
 */
export const eventBus = createEventBus()

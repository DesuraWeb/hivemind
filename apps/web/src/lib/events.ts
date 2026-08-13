/**
 * Miroir front de `BusEvent` (events/bus.ts) : charge minimale, un type et
 * des identifiants. Le front recharge via l'API REST à réception — jamais de
 * polling, jamais l'objet complet sur le fil SSE.
 */
export type BusEvent =
  | { type: 'inbox.new'; id: string; projectId: string | null }
  | { type: 'inbox.resolved'; id: string; projectId: string | null }
  | { type: 'run.state'; runId: string; projectId: string }
  | { type: 'budget.tick'; projectId: string }

function isBusEvent(value: unknown): value is BusEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  )
}

/**
 * Abonnement à `GET /api/events` (brief §8 : flux SSE unique et typé, jamais
 * de boucle de polling). `EventSource` gère lui-même la reconnexion —
 * `withCredentials` est nécessaire pour que le cookie de session (même
 * origine, via le proxy Vite) parte avec la requête.
 *
 * Retourne la fonction de désabonnement, à appeler impérativement au
 * démontage — même contrat que `EventBus.subscribe` côté serveur.
 */
export function subscribeToEvents(onEvent: (event: BusEvent) => void): () => void {
  const source = new EventSource('/api/events', { withCredentials: true })
  source.onmessage = (msg) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(msg.data)
    } catch {
      return // commentaires SSE (heartbeat ": \n\n") n'émettent pas onmessage ; ignoré si jamais malformé
    }
    if (isBusEvent(parsed)) onEvent(parsed)
  }
  return () => source.close()
}

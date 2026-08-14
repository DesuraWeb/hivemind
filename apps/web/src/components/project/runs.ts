import type { RunState } from '@silithid/shared'
import type { RunView } from '../../lib/project-types'

export interface RunTone {
  label: string
  color: string
  pulse: boolean
}

/**
 * État de run → libellé affiché dans la liste des boucles (Projet.dc.html,
 * `RUNS[].result` : « en cours », « validé », « échec reviewer »…).
 *
 * Le prototype écrit des résultats rédigés à la main (« corrigé par juge ») ;
 * ici le seul fait dont on dispose est l'état machine du run. On le nomme,
 * on ne le romance pas.
 */
export function runTone(state: RunState): RunTone {
  switch (state) {
    case 'done':
      return { label: 'validé', color: 'var(--ok)', pulse: false }
    case 'failed':
      return { label: 'échec', color: 'var(--sem-alert)', pulse: false }
    case 'awaiting_human':
      return { label: 'en attente humain', color: 'var(--sem-question)', pulse: false }
    case 'paused_budget':
      return { label: 'pause budget', color: 'var(--pause)', pulse: false }
    case 'paused_human':
      return { label: 'pause · vous', color: 'var(--pause)', pulse: false }
    /**
     * Terminal, et distinct d'`échec` : un arrêt est une décision, un échec un
     * constat. Sans cette branche, le `default` faisait lire « en cours » avec
     * sa pastille qui palpite sur une boucle coupée depuis une heure.
     */
    case 'stopped':
      return { label: 'stoppée', color: 'var(--text-low)', pulse: false }
    case 'verdict':
      return { label: 'verdict', color: 'var(--sem-verdict)', pulse: true }
    default:
      return { label: 'en cours', color: 'var(--accent)', pulse: true }
  }
}

/**
 * Le run avance-t-il encore ? Même partition que `loopFromRunState` côté
 * serveur — et que les `OCCUPYING_STATES` de `loop/start.ts`, qui décident si
 * un step est libre : les trois états terminaux (`done`, `failed`, `stopped`)
 * le libèrent, tous les autres l'occupent.
 */
export function isRunActive(state: RunState): boolean {
  return state !== 'done' && state !== 'failed' && state !== 'stopped'
}

/**
 * `run_8f3a2c` du pack : nos identifiants sont des uuid, on n'en garde que la
 * tête — assez pour reconnaître un run dans une liste, jamais présenté comme
 * l'identifiant complet.
 */
export function shortRunId(id: string): string {
  return `run_${id.slice(0, 6)}`
}

/**
 * « 09:02 » aujourd'hui, « hier 16:40 », « lun. 15:22 » au-delà — la forme du
 * pack. Séparateur « · » réservé aux compositions de plus haut niveau.
 */
export function formatRunTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const hhmm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (days <= 0) return hhmm
  if (days === 1) return `hier ${hhmm}`
  if (days < 7) return `${d.toLocaleDateString('fr-FR', { weekday: 'short' })} ${hhmm}`
  return `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${hhmm}`
}

/** Durée écoulée, même formulation que `formatDuree` côté serveur (« 14 min », « 2 h 05 min »). */
export function elapsedSince(iso: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** Le run le plus récent — la liste rendue par l'API est déjà triée du plus récent au plus ancien. */
export function latestRun(runs: RunView[]): RunView | null {
  return runs[0] ?? null
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import type { RunView, StepView } from '../../lib/project-types'
import { runStateTone } from './state'

/**
 * Le 409 de `POST /api/steps/:id/start` porte le run qui occupe déjà le step
 * (`{ error, runId, state }`). C'est la seule information qui permet de
 * proposer d'OUVRIR la boucle en cours au lieu d'afficher un refus — d'où le
 * corps brut conservé sur `ApiError`.
 */
function alreadyRunning(err: unknown): { runId: string; state: string } | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null
  const payload = err.payload
  if (typeof payload !== 'object' || payload === null) return null
  const { runId, state } = payload as { runId?: unknown; state?: unknown }
  if (typeof runId !== 'string') return null
  return { runId, state: typeof state === 'string' ? state : 'en cours' }
}

/**
 * Démarrer une boucle sur un step · le geste qui manquait.
 *
 * `insertInto('runs')` n'existait que dans les tests et les scripts : toute la
 * machinerie était là, et rien dans l'application ne savait la lancer. Le
 * bouton vit sur la fiche projet, à côté du step qu'il fait partir.
 *
 * ## Deux temps, volontairement
 *
 * Un clic lance de VRAIS agents et consomme de vrais tokens. Le bouton demande
 * donc confirmation, comme l'arrêt le fait dans « Run en direct » — la fenêtre
 * de 3,2 s est reprise du pack (`askStop`). Une dépense irréversible derrière
 * un clic unique serait le seul endroit de l'application où un geste coûteux
 * n'aurait aucun garde-fou.
 *
 * ## Le 409
 *
 * Un step déjà occupé n'est pas une erreur à afficher : c'est une invitation à
 * ouvrir la boucle qui tourne. On propose donc le lien, avec l'état où elle en
 * est, et jamais un « ça n'a pas marché ».
 */
export function StartLoop({
  step,
  activeRun,
  projectId,
}: {
  step: StepView
  /** Le run qui occupe ce step, s'il y en a un — le bouton devient alors un lien. */
  activeRun: RunView | null
  projectId: string
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [conflict, setConflict] = useState<{ runId: string; state: string } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  const start = useMutation({
    mutationFn: () => api.runs.start(step.id),
    onSuccess: (started) => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      void navigate({ to: '/runs/$runId', params: { runId: started.runId } })
    },
    onError: (err) => {
      const running = alreadyRunning(err)
      if (running) {
        setConflict(running)
        // La liste des runs est périmée : c'est justement ce qui a permis au
        // bouton de s'afficher alors qu'une boucle tournait déjà.
        void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
        return
      }
      setFailure(
        err instanceof ApiError
          ? `démarrage impossible · ${err.message}`
          : 'démarrage impossible · le serveur est injoignable',
      )
    },
  })

  // Le refus passe AVANT l'affichage nominal : la liste des runs se rafraîchit
  // dans la foulée du 409 et ferait sinon disparaître le message avant qu'on
  // l'ait lu — le bouton se transformerait tout seul en lien, sans jamais dire
  // pourquoi le clic n'a rien lancé.
  if (conflict) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '10.5px var(--font-mono)', color: 'var(--sem-question)' }}>
          une boucle occupe déjà ce step · {runStateTone(conflict.state).label}
        </span>
        <Link
          to="/runs/$runId"
          params={{ runId: conflict.runId }}
          style={{ font: '500 12.5px var(--font-sans)', whiteSpace: 'nowrap' }}
        >
          Ouvrir la boucle en cours →
        </Link>
      </span>
    )
  }

  if (activeRun) {
    const tone = runStateTone(activeRun.state)
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
        <span style={{ font: '10.5px var(--font-mono)', color: tone.color }}>{tone.label}</span>
        <Link
          to="/runs/$runId"
          params={{ runId: activeRun.id }}
          style={{ font: '500 12.5px var(--font-sans)', whiteSpace: 'nowrap' }}
        >
          Suivre en direct →
        </Link>
      </span>
    )
  }

  function click() {
    if (start.isPending) return
    if (!confirming) {
      setConfirming(true)
      timer.current = window.setTimeout(() => setConfirming(false), 3200)
      return
    }
    if (timer.current !== null) window.clearTimeout(timer.current)
    setConfirming(false)
    setFailure(null)
    start.mutate()
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {failure && (
        <span style={{ font: '10.5px var(--font-mono)', color: 'var(--sem-alert)' }}>
          {failure}
        </span>
      )}
      <button
        type="button"
        onClick={click}
        disabled={start.isPending}
        title="Lance la boucle garant → dev → reviewer → juge sur ce step · de vrais agents, de vrais tokens"
        style={{
          padding: '7px 14px',
          borderRadius: 'var(--r-full)',
          border: `1px solid ${
            confirming
              ? 'color-mix(in oklab, var(--sem-question) 55%, transparent)'
              : 'color-mix(in oklab, var(--accent) 50%, transparent)'
          }`,
          background: confirming
            ? 'color-mix(in oklab, var(--sem-question) 12%, transparent)'
            : 'transparent',
          color: confirming ? 'var(--text-hi)' : 'var(--accent)',
          font: '500 12.5px var(--font-sans)',
          cursor: start.isPending ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
          transition: 'all var(--dur-1) var(--ease)',
        }}
      >
        {start.isPending
          ? 'démarrage…'
          : confirming
            ? 'Confirmer · agents réels'
            : 'Démarrer la boucle'}
      </button>
    </span>
  )
}

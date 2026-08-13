import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { CreateGlobeForm } from '../components/globes/CreateGlobeForm'
import { GlobesStage } from '../components/globes/GlobesStage'
import { ApiError, type CreateGlobeInput, api } from '../lib/api'
import { subscribeToEvents } from '../lib/events'

const GLOBES_QUERY_KEY = ['globes'] as const

/**
 * Page Globes (plan Phase 3, Task 8) : système solaire, Hive au centre, une
 * orbite par globe (GlobesStage). Branché sur `GET /api/globes`, rafraîchi
 * par le SSE existant. CRUD minimal : création par formulaire simple
 * (`POST /api/globes`) — pas d'édition ni de suppression, hors du périmètre
 * « minimal » du plan.
 *
 * En-tête en survol absolu du plein cadre (pas `<SectionHeader>` en flux,
 * contrairement aux autres écrans) : c'est le parti du prototype
 * (`Globes.dc.html`) — la scène occupe tout l'espace disponible, le header
 * flotte dessus plutôt que de lui retirer de la hauteur.
 */
export function Globes() {
  const queryClient = useQueryClient()
  const globesQuery = useQuery({ queryKey: GLOBES_QUERY_KEY, queryFn: api.globes.list })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | undefined>(undefined)

  useEffect(() => {
    return subscribeToEvents((evt) => {
      if (evt.type === 'inbox.new' || evt.type === 'inbox.resolved' || evt.type === 'run.state') {
        void queryClient.invalidateQueries({ queryKey: GLOBES_QUERY_KEY })
      }
    })
  }, [queryClient])

  const createMutation = useMutation({
    mutationFn: (input: CreateGlobeInput) => api.globes.create(input),
    onSuccess: () => {
      setCreating(false)
      setCreateError(undefined)
      void queryClient.invalidateQueries({ queryKey: GLOBES_QUERY_KEY })
    },
    onError: (err: unknown) => {
      setCreateError(err instanceof ApiError ? err.message : 'création impossible')
    },
  })

  const globes = globesQuery.data ?? []
  const totalProjects = globes.reduce((s, g) => s + g.projectCount, 0)
  const totalActive = globes.reduce((s, g) => s + g.activeCount, 0)

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <header
        style={{
          position: 'absolute',
          left: 24,
          right: 24,
          top: 18,
          zIndex: 20,
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          {/* Globes.dc.html : contrairement à SectionHeader (Task 6, réservé aux
              en-têtes en flux), ce label est en mono 10.5px — pas `--fs-label`/
              `--font-sans`. Écart repéré à l'audit pixel (rapport Task 8) et corrigé ici. */}
          <span
            style={{
              font: '600 10.5px var(--font-mono)',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--text-mid)',
            }}
          >
            Globes
          </span>
          <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
            {globes.length} globe{globes.length > 1 ? 's' : ''} · {totalProjects} projet
            {totalProjects > 1 ? 's' : ''} · {totalActive} boucle{totalActive > 1 ? 's' : ''} active
            {totalActive > 1 ? 's' : ''}
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            setCreateError(undefined)
            setCreating((v) => !v)
          }}
          style={{
            display: 'inline-flex',
            padding: '7px 15px',
            borderRadius: 'var(--r-full)',
            border: '1px solid color-mix(in oklab, var(--accent) 40%, transparent)',
            background: 'var(--accent-soft)',
            color: 'var(--text-hi)',
            font: '500 12.5px var(--font-sans)',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          }}
        >
          + Nouveau globe
        </button>
      </header>

      <GlobesStage globes={globes} />

      {creating && (
        <CreateGlobeForm
          submitting={createMutation.isPending}
          onCancel={() => setCreating(false)}
          onSubmit={(input) => createMutation.mutate(input)}
          {...(createError ? { error: createError } : {})}
        />
      )}

      <div
        style={{
          position: 'absolute',
          left: 24,
          bottom: 18,
          zIndex: 20,
          font: '10.5px var(--font-mono)',
          color: 'var(--text-low)',
          maxWidth: 250,
          lineHeight: 1.7,
        }}
      >
        une orbite par globe · taille selon données
        <br />
        chaque globe = un espace de conscience
      </div>
    </div>
  )
}

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { OrbCanvas } from '../components/OrbCanvas'
import { AmbientClock } from '../components/ambient/AmbientClock'
import { AmbientFocusLine } from '../components/ambient/AmbientFocusLine'
import { AmbientStatus } from '../components/ambient/AmbientStatus'
import { useFocusCycle } from '../components/ambient/useFocusCycle'
import { useIdleCursor } from '../components/ambient/useIdleCursor'
import { api } from '../lib/api'
import { subscribeToEvents } from '../lib/events'
import type { OrbInstance, OrbProject } from '../vendor/orb'

const PROJECTS_QUERY_KEY = ['projects'] as const
const INBOX_QUERY_KEY = ['inbox'] as const

/**
 * Mode ambient (`docs/design/Ambient.dc.html`) : l'orbe seule, plein écran,
 * sans rien à cliquer · un écran de télévision qui tourne tout seul.
 *
 * Trois choix méritent d'être écrits ici.
 *
 * **Le plein écran est un calque, pas une route hors du socle.** `router.tsx`
 * range `/ambient` sous `Layout` comme toutes les autres pages, et ce fichier
 * n'a pas à défaire ce choix : la page se pose en `position: fixed` au-dessus
 * du rail et du bandeau Hive. Le calque part en `createPortal` vers `body`,
 * et pas simplement en `z-index` élevé : la colonne de contenu de `Layout` est
 * elle-même un contexte d'empilement (`position: relative; z-index: 1`), donc
 * tout z-index posé à l'intérieur y reste enfermé — le rail (z-index 40, hors
 * de cette colonne) passait par-dessus, vérifié à l'écran avant correction.
 * Conséquence assumée : la palette ⌘K, montée dans cette même colonne, passe
 * elle aussi sous le calque. En mode ambient il n'y a donc qu'une commande,
 * échap · c'est le contrat de l'écran, et le rappel en bas à droite le dit.
 *
 * **Rien n'est cliquable, donc rien ne réagit au survol.** `OrbCanvas` est
 * monté sans `onHover` ni `onClusterClick` : le focus vient du cycle, pas
 * d'une main. C'est la différence de fond avec le dashboard, qui partage
 * pourtant la même orbe.
 *
 * **L'écran reste juste sans personne devant.** Il tourne des heures : les
 * compteurs se rafraîchissent sur le flux SSE déjà en place, jamais par
 * polling — sauf la jauge de budget, dont la mesure est gratuite côté serveur
 * et qui s'échantillonne à la minute (`AmbientStatus`).
 */
export function Ambient() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const projectsQuery = useQuery({ queryKey: PROJECTS_QUERY_KEY, queryFn: api.projects.list })
  const inboxQuery = useQuery({
    queryKey: INBOX_QUERY_KEY,
    queryFn: () => api.inbox.list({ status: 'open' }),
  })

  useEffect(() => {
    return subscribeToEvents((evt) => {
      if (evt.type === 'inbox.new' || evt.type === 'inbox.resolved') {
        void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      }
      if (evt.type === 'run.state') {
        void queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY })
      }
      if (evt.type === 'budget.tick') {
        void queryClient.invalidateQueries({ queryKey: ['budget'] })
      }
    })
  }, [queryClient])

  // Échap ramène au dashboard (`Ambient.dc.html`, l. 70). C'est la sortie de
  // l'écran : le calque couvre le rail nav, il n'y a pas d'autre chemin que
  // cette touche et le rappel en bas à droite.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void navigate({ to: '/' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  const idle = useIdleCursor()

  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])
  const orbProjects: OrbProject[] = useMemo(
    () =>
      projects
        .filter((p) => p.tint)
        .map((p) => ({ id: p.id, tint: p.tint as string, nodes: p.nodes })),
    [projects],
  )

  const orbRef = useRef<OrbInstance | null>(null)
  // Stable : `useFocusCycle` ne remonte pas son minuteur quand le parent rend,
  // et lit toujours l'instance courante de l'orbe par la ref.
  const applyFocus = useCallback((id: string | null) => {
    orbRef.current?.focus(id)
  }, [])

  const cycleIds = useMemo(() => orbProjects.map((p) => p.id), [orbProjects])
  const focusedId = useFocusCycle({ ids: cycleIds, onFocus: applyFocus })
  const focusedProject = projects.find((p) => p.id === focusedId) ?? null

  return createPortal(
    <div
      data-screen-label="Ambient · écran TV"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        overflow: 'hidden',
        background:
          'radial-gradient(1000px 700px at 50% 48%, color-mix(in oklab, var(--accent) 5%, transparent), transparent 72%), var(--bg-0)',
        color: 'var(--text-hi)',
        fontFamily: 'var(--font-sans)',
        cursor: idle ? 'none' : 'default',
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      <div
        data-chapo-ambiance="1"
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}
      />

      <div style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
        {orbProjects.length > 0 && (
          <OrbCanvas
            projects={orbProjects}
            config={{ PARALLAX: 0.03, ROT_SPEED: 0.035 }}
            // La scène est reconstruite quand la liste de clusters change : on
            // récupère la nouvelle instance, et le cycle repart de la vue
            // d'ensemble au même instant (`useFocusCycle` dépend des mêmes ids).
            onReady={(orb) => {
              orbRef.current = orb
            }}
          />
        )}
      </div>

      {/* Sans projet, il n'y a pas d'orbe : `orb.js` a besoin d'au moins un
          cluster, et une sphère vide donnerait à croire qu'un système tourne.
          L'écran dit ce qu'il en est et laisse l'heure faire le reste. */}
      {orbProjects.length === 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            pointerEvents: 'none',
            textAlign: 'center',
            padding: '0 40px',
          }}
        >
          <span style={{ font: '500 15px var(--font-sans)', color: 'var(--text-mid)' }}>
            {projectsQuery.isPending
              ? 'Chargement des projets…'
              : projectsQuery.isError
                ? 'Les projets ne répondent pas.'
                : "Aucun projet à faire tourner pour l'instant."}
          </span>
          {!projectsQuery.isPending && (
            <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
              {projectsQuery.isError
                ? "l'orbe reste éteinte tant que la liste n'est pas revenue"
                : "l'orbe s'allumera au premier projet créé"}
            </span>
          )}
        </div>
      )}

      <AmbientClock />
      <AmbientStatus
        projects={
          projectsQuery.isError
            ? { state: 'error' }
            : projectsQuery.data
              ? { state: 'ok', value: projectsQuery.data }
              : { state: 'pending' }
        }
        decisions={
          inboxQuery.isError
            ? { state: 'error' }
            : inboxQuery.data
              ? { state: 'ok', value: inboxQuery.data.length }
              : { state: 'pending' }
        }
      />
      <AmbientFocusLine project={focusedProject} />

      <Link
        to="/"
        style={{
          position: 'absolute',
          right: 40,
          bottom: 34,
          zIndex: 3,
          font: '11px var(--font-mono)',
          color: 'var(--text-low)',
          opacity: idle ? 0 : 1,
          transition: 'opacity var(--dur-3) var(--ease)',
        }}
      >
        esc · retour au dashboard
      </Link>
    </div>,
    document.body,
  )
}

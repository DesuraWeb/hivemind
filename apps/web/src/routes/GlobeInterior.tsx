import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { OrbCanvas } from '../components/OrbCanvas'
import { ClusterHalo } from '../components/globe/ClusterHalo'
import { GlobeFocusPanel } from '../components/globe/GlobeFocusPanel'
import { ProjectRow } from '../components/globe/ProjectRow'
import { api } from '../lib/api'
import { subscribeToEvents } from '../lib/events'
import type { ProjectView } from '../lib/project-types'
import type { OrbInstance, OrbProject } from '../vendor/orb'

const GLOBES_QUERY_KEY = ['globes'] as const

/**
 * `orb.js` passe la teinte à `new THREE.Color(p.tint)` sans la résoudre par
 * son sondeur CSS (contrairement à ses propres couleurs) : une `var(--…)` y
 * ressort noire. Le repli est donc la valeur littérale du token `--pause`,
 * pas son nom.
 */
const FALLBACK_TINT = '#7A8698'

/**
 * Intérieur d'un globe (pack DA : `Projets.dc.html`).
 *
 * Route `/globes/$globeId` : l'URL EST le fil d'Ariane demandé par CLAUDE.md
 * (« Projets.dc.html = intérieur du globe Desura, breadcrumb Globes /
 * Desura »), et `/globes` reste la route parente partagée avec la fiche
 * projet `/globes/$globeId/$projectId`.
 *
 * Deux moitiés : à gauche une liste dense sans cadres, dimensionnée pour 100+
 * projets (DOM simple + scroll, lignes mémoïsées — cf. ProjectRow) ; à droite
 * UNE SEULE orbe, un cluster par projet. Les orbes par projet sont
 * explicitement abandonnées par le pack (limite de contextes WebGL) : il n'y
 * a qu'un `OrbCanvas` sur cette page, quel que soit le nombre de projets.
 */
export function GlobeInterior() {
  const { globeId } = useParams({ from: '/globes/$globeId' })
  const queryClient = useQueryClient()

  const projectsKey = useMemo(() => ['projects', 'globe', globeId] as const, [globeId])
  const projectsQuery = useQuery({
    queryKey: projectsKey,
    queryFn: () => api.projects.byGlobe(globeId),
  })
  const globesQuery = useQuery({ queryKey: GLOBES_QUERY_KEY, queryFn: api.globes.list })

  useEffect(() => {
    return subscribeToEvents((evt) => {
      if (evt.type === 'inbox.new' || evt.type === 'inbox.resolved' || evt.type === 'run.state') {
        void queryClient.invalidateQueries({ queryKey: projectsKey })
      }
    })
  }, [queryClient, projectsKey])

  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])
  const globeName = globesQuery.data?.find((g) => g.id === globeId)?.name ?? globeId

  const [hoverId, setHoverId] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [orb, setOrb] = useState<OrbInstance | null>(null)

  // Callbacks stables : `ProjectRow` est mémoïsé, des fermetures recréées à
  // chaque rendu annuleraient le mémo et re-rendraient les 100 lignes à
  // chaque mouvement de souris.
  const handleHover = useCallback((id: string | null) => setHoverId(id), [])

  const toggleFocus = useCallback((id: string | null) => {
    setFocused((cur) => (cur === id ? null : id))
  }, [])

  const handlePick = useCallback((id: string) => toggleFocus(id), [toggleFocus])

  // L'orbe suit l'état React, jamais l'inverse : `focus()` est un effet de
  // bord, il n'a rien à faire dans un updater de `setState` (React peut le
  // rejouer). Une seule source de vérité, `focused`.
  useEffect(() => {
    orb?.focus(focused)
  }, [orb, focused])

  const orbProjects: OrbProject[] = useMemo(
    () =>
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        tint: p.tint ?? FALLBACK_TINT,
        nodes: p.nodes,
      })),
    [projects],
  )

  const handleOrbHover = useCallback((p: OrbProject | null) => {
    setHoverId(p ? p.id : null)
  }, [])

  const handleClusterClick = useCallback((id: string | null) => {
    // Clic dans le vide : on relâche le focus (Projets.dc.html, onClusterClick).
    setFocused((cur) => {
      const target = id ?? cur
      return target === null ? cur : cur === target ? null : target
    })
  }, [])

  const focusedProject: ProjectView | null = projects.find((p) => p.id === focused) ?? null
  const hoveredProject: ProjectView | null = projects.find((p) => p.id === hoverId) ?? null

  const activeCount = projects.filter((p) => p.loop === 'run').length
  const pendingCount = projects.reduce((s, p) => s + p.pending.reduce((n, x) => n + x.n, 0), 0)

  return (
    <>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          // Même correction que `SectionHeader` : sans repli, le compte de
          // projets et le bouton « + Nouveau projet » sortaient du cadre sur un
          // écran étroit, et se faisaient couper au lieu de passer à la ligne.
          flexWrap: 'wrap',
          gap: '8px 20px',
          padding: '18px 24px 0',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 12,
            flexWrap: 'wrap',
            minWidth: 0,
          }}
        >
          <span
            style={{
              font: '600 10.5px var(--font-mono)',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--text-low)',
            }}
          >
            <Link
              to="/globes"
              style={{ font: 'inherit', letterSpacing: 'inherit', color: 'inherit' }}
            >
              Globes
            </Link>{' '}
            / <span style={{ color: 'var(--text-mid)' }}>{globeName}</span>
          </span>
          <span
            style={{
              font: '11.5px var(--font-mono)',
              color: 'var(--text-low)',
              whiteSpace: 'nowrap',
            }}
          >
            {/* Accord français : zéro reste au singulier (« 0 projet »), comme
                sur la page Globes. */}
            {projects.length} projet{projects.length > 1 ? 's' : ''} · {activeCount} boucle
            {activeCount > 1 ? 's' : ''} active{activeCount > 1 ? 's' : ''} · {pendingCount} en
            attente
          </span>
        </div>
        {/* Projets.dc.html ~l. 43 : « + Nouveau projet » → Creation.dc.html.
            Le globe d'accueil est déjà connu ici : il part en recherche avec
            le mode, pour que la scène ouvre directement le script projet. */}
        <Link
          to="/creation"
          search={{ mode: 'projet', globe: globeId }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 15px',
            borderRadius: 'var(--r-full)',
            border: '1px solid color-mix(in oklab, var(--accent) 40%, transparent)',
            background: 'var(--accent-soft)',
            color: 'var(--text-hi)',
            font: '500 12.5px var(--font-sans)',
            whiteSpace: 'nowrap',
          }}
        >
          + Nouveau projet
        </Link>
      </header>

      {/*
        L'orbe occupe TOUTE la largeur, la liste flotte par-dessus.
        
        C'était une rangée flex : une colonne de projets, puis le canvas en
        `flex: 1`. L'orbe était donc centrée dans ce qui restait à droite, pas
        dans l'écran — et avec un seul projet, la colonne réservait 480 px de
        vide et poussait l'orbe d'autant. Constaté par Florian sur une orbe à
        un projet.
        
        Le sujet de cette page est l'orbe. La liste est une lecture par-dessus,
        même composition que l'écran de Création, où les fragments flottent au-
        dessus de la scène sans jamais la décaler.
      */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          padding: '10px 24px 120px',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 24,
            top: 10,
            bottom: 120,
            zIndex: 5,
            width: 'clamp(360px, 34vw, 460px)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            overflowY: 'auto',
            // La liste ne doit pas capter le clic sur toute sa hauteur : au-
            // dessous des cartes, c'est l'orbe qu'on veut pouvoir attraper.
            pointerEvents: 'none',
            padding: '4px 6px 4px 0',
          }}
        >
          {/*
            Le clic revient aux cartes. Le conteneur le laisse passer pour que
            l'orbe reste attrapable dans le vide sous la liste, mais une carte
            inerte serait un bouton qui ne répond pas.
          */}
          {projects.map((p) => (
            <div key={p.id} style={{ pointerEvents: 'auto' }}>
              <ProjectRow
                project={p}
                globeId={globeId}
                hovered={hoverId === p.id}
                focused={focused === p.id}
                onHover={handleHover}
                onPick={handlePick}
              />
            </div>
          ))}
          {projects.length === 0 && !projectsQuery.isPending && (
            <div
              style={{
                padding: '12px 13px',
                pointerEvents: 'auto',
                font: '11.5px var(--font-mono)',
                color: 'var(--text-low)',
                lineHeight: 1.7,
              }}
            >
              aucun projet dans ce globe
              <br />
              un globe vide reste un espace de conscience · sa mémoire est déjà là
            </div>
          )}
          {projects.length > 0 && (
            <div
              style={{
                padding: '12px 13px',
                font: '10.5px var(--font-mono)',
                color: 'var(--text-low)',
              }}
            >
              1 canvas WebGL · un cluster par projet · cible 5 000 nœuds @ 60 fps
            </div>
          )}
        </div>

        <div style={{ position: 'absolute', inset: 0 }}>
          {orbProjects.length > 0 ? (
            <>
              <OrbCanvas
                projects={orbProjects}
                config={{ PARALLAX: 0.06 }}
                onHover={handleOrbHover}
                onClusterClick={handleClusterClick}
                onReady={setOrb}
              />
              <ClusterHalo
                orb={orb}
                hoveredId={hoverId}
                label={hoveredProject?.name ?? ''}
                tint={hoveredProject?.tint ?? FALLBACK_TINT}
              />
            </>
          ) : (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                font: '10.5px var(--font-mono)',
                color: 'var(--text-low)',
                textAlign: 'center',
                lineHeight: 1.8,
              }}
            >
              {projectsQuery.isPending
                ? 'chargement…'
                : "pas de cluster à afficher · l'orbe attend un premier projet"}
            </div>
          )}

          {focusedProject && (
            <GlobeFocusPanel
              project={focusedProject}
              globeId={globeId}
              onRelease={() => toggleFocus(focusedProject.id)}
            />
          )}
        </div>
      </main>
    </>
  )
}

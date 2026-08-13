import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { OrbCanvas } from '../components/OrbCanvas'
import { SectionHeader } from '../components/SectionHeader'
import { BriefPanel } from '../components/dashboard/BriefPanel'
import { FocusPanel } from '../components/dashboard/FocusPanel'
import { HoverCard } from '../components/dashboard/HoverCard'
import { LOOP_ORDER, badgeFor } from '../components/dashboard/loop'
import { SEM } from '../components/inbox/constants'
import { ageMinutes, formatAge } from '../lib/age'
import { api } from '../lib/api'
import { subscribeToEvents } from '../lib/events'
import type { InboxItemView } from '../lib/inbox-types'
import type { ProjectView } from '../lib/project-types'
import type { OrbInstance, OrbProject } from '../vendor/orb'

const PROJECTS_QUERY_KEY = ['projects'] as const
const INBOX_QUERY_KEY = ['inbox'] as const

const CHIP_TYPES = ['question', 'approval', 'verdict', 'alert'] as const
const CHIP_LABELS: Record<(typeof CHIP_TYPES)[number], string> = {
  question: 'Questions',
  approval: 'Validations',
  verdict: 'Verdicts',
  alert: 'Alertes',
}

function formatClock(d: Date): string {
  const date = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })
  const time = d.toLocaleTimeString('fr-FR')
  return `${date} · ${time}`
}

/** Le plus ancien item du type donné (celui bloqué depuis le plus longtemps) — même sémantique que `oldest` de data.js. */
function oldestOf(items: InboxItemView[], type: string): InboxItemView | null {
  return items
    .filter((i) => i.type === type)
    .reduce<InboxItemView | null>(
      (acc, i) => (!acc || ageMinutes(i.blockedSince) > ageMinutes(acc.blockedSince) ? i : acc),
      null,
    )
}

/**
 * Dashboard (plan Phase 3, Task 8). Brief du matin en panneau de verre
 * flottant SUR l'orbe, chips de compteurs en une ligne sous le header,
 * boucles aérées (méta courte, détail en `title`), budget replié. Une seule
 * orbe (OrbCanvas → orb.js vendor), branchée sur `/api/projects` et
 * `/api/inbox`, rafraîchie par le SSE déjà en place — jamais de polling.
 *
 * Focus au clic : un seul point d'entrée, `toggleFocus`, exactement comme
 * `_toggleFocus` du prototype. Deux sources le déclenchent et restent donc
 * synchronisées sur le même état — un cluster de l'orbe et une ligne de la
 * liste « Boucles » — et il pilote à la fois l'état React (panneau de verre,
 * ligne surlignée) et la caméra (`orb.focus(id)`, transition complète déjà
 * écrite dans le vendor). Recliquer le même projet, cliquer dans le vide de
 * l'orbe ou le × du panneau relâchent. La carte suiveuse est coupée pendant
 * le focus : le panneau fixe prend le relais.
 */
export function Dashboard() {
  const queryClient = useQueryClient()
  const projectsQuery = useQuery({ queryKey: PROJECTS_QUERY_KEY, queryFn: api.projects.list })
  const inboxQuery = useQuery({
    queryKey: INBOX_QUERY_KEY,
    queryFn: () => api.inbox.list({ status: 'open' }),
  })

  const [clock, setClock] = useState(() => formatClock(new Date()))
  useEffect(() => {
    const id = setInterval(() => setClock(formatClock(new Date())), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    return subscribeToEvents((evt) => {
      if (evt.type === 'inbox.new' || evt.type === 'inbox.resolved') {
        void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      }
      if (evt.type === 'run.state') {
        void queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY })
      }
    })
  }, [queryClient])

  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])
  const inboxItems = useMemo(() => inboxQuery.data ?? [], [inboxQuery.data])

  const projectsById = useMemo(() => {
    const map = new Map<string, ProjectView>()
    for (const p of projects) map.set(p.id, p)
    return map
  }, [projects])
  const projectName = (slug: string | null): string =>
    slug ? (projectsById.get(slug)?.name ?? slug) : '·'

  const orbHostRef = useRef<HTMLDivElement>(null)
  const orbRef = useRef<OrbInstance | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [hover, setHover] = useState<{ project: ProjectView; left: number; top: number } | null>(
    null,
  )

  /**
   * Point d'entrée unique du focus (`_toggleFocus` du prototype) : bascule
   * l'état, puis demande la transition de caméra au vendor. Passer `null` à
   * `orb.focus` déclenche le retour idle (UNFOCUS_DUR, rotation reprise).
   */
  const toggleFocus = (id: string) => {
    const next = focused === id ? null : id
    setFocused(next)
    orbRef.current?.focus(next)
    // Le prototype ne coupe la carte suiveuse qu'au prochain `onHover` : si le
    // curseur ne bouge plus après le clic, elle reste affichée par-dessus
    // l'orbe en focus. On la coupe tout de suite (« pas de carte suiveuse en
    // focus », docs/design/CLAUDE.md).
    if (next) setHover(null)
  }
  const releaseFocus = () => {
    setFocused(null)
    orbRef.current?.focus(null)
  }

  const focusedProject = focused ? (projectsById.get(focused) ?? null) : null
  // Le projet focalisé peut disparaître d'un rafraîchissement SSE : sans ce
  // garde-fou l'orbe resterait bloquée sur un cluster qui n'existe plus.
  useEffect(() => {
    if (focused && !projectsById.has(focused)) {
      setFocused(null)
      orbRef.current?.focus(null)
    }
  }, [focused, projectsById])

  const handleHover = (op: OrbProject | null, x: number, y: number) => {
    // En focus, la carte suiveuse est désactivée : le panneau fixe prend le
    // relais (Dashboard.dc.html, `onHover`).
    if (!op || focused) {
      setHover(null)
      return
    }
    const proj = projectsById.get(op.id)
    const hostRect = orbHostRef.current?.getBoundingClientRect()
    if (!proj || !hostRect) {
      setHover(null)
      return
    }
    setHover({
      project: proj,
      left: Math.min(hostRect.left + x + 18, window.innerWidth - 296),
      top: Math.min(hostRect.top + y + 18, window.innerHeight - 200),
    })
  }

  const orbProjects: OrbProject[] = useMemo(
    () =>
      projects
        .filter((p) => p.tint)
        .map((p) => ({ id: p.id, tint: p.tint as string, nodes: p.nodes })),
    [projects],
  )

  const activeCount = projects.filter((p) => p.loop === 'run').length
  const alertItems = inboxItems.filter((i) => i.type === 'alert')

  const decisions = inboxItems.length
  const oldestOverall = inboxItems.reduce<InboxItemView | null>(
    (acc, i) => (!acc || ageMinutes(i.blockedSince) > ageMinutes(acc.blockedSince) ? i : acc),
    null,
  )
  const briefSummary =
    decisions > 0
      ? `${decisions} décision${decisions > 1 ? 's' : ''} en attente${
          oldestOverall
            ? ` · la plus ancienne date de ${formatAge(oldestOverall.blockedSince)}`
            : ''
        }${alertItems[0] ? ` · alerte sur ${projectName(alertItems[0].project)}` : ''}.`
      : "Rien n'attend de décision pour l'instant."

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => LOOP_ORDER[a.loop] - LOOP_ORDER[b.loop]),
    [projects],
  )

  const [budgetOpen, setBudgetOpen] = useState(false)

  return (
    <>
      <SectionHeader
        label="Dashboard"
        meta={clock}
        right={
          <>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                font: '11.5px var(--font-mono)',
                color: 'var(--text-mid)',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: 'var(--accent)',
                  animation: activeCount > 0 ? 'chapoPulse 1.8s var(--ease) infinite' : 'none',
                }}
              />
              {activeCount} boucle{activeCount === 1 ? '' : 's'} active
              {activeCount === 1 ? '' : 's'}
            </span>
            {alertItems.length > 0 && (
              <Link
                to="/inbox"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  font: '11.5px var(--font-mono)',
                  color: 'var(--sem-alert)',
                  whiteSpace: 'nowrap',
                }}
              >
                <span
                  style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--sem-alert)' }}
                />
                {alertItems.length} alerte{alertItems.length > 1 ? 's' : ''} ·{' '}
                {projectName(alertItems[0]?.project ?? null)}
              </Link>
            )}
          </>
        }
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 20,
          padding: '12px 20px 0',
          flexShrink: 0,
        }}
      >
        {CHIP_TYPES.map((type) => {
          const count = inboxItems.filter((i) => i.type === type).length
          const oldest = oldestOf(inboxItems, type)
          return (
            <Link
              key={type}
              to="/inbox"
              title={oldest ? `plus ancien : ${formatAge(oldest.blockedSince)}` : 'rien en attente'}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                color: 'var(--text-mid)',
                font: '500 12px var(--font-sans)',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 999, background: SEM[type] }} />
              <span style={{ font: '600 12px var(--font-mono)', color: 'var(--text-hi)' }}>
                {count}
              </span>
              <span>{CHIP_LABELS[type]}</span>
            </Link>
          )
        })}
      </div>

      <main style={{ flex: 1, minHeight: 0, position: 'relative', padding: '0 20px 20px' }}>
        <div
          ref={orbHostRef}
          style={{
            position: 'absolute',
            inset: '12px 20px 20px',
            borderRadius: 'var(--r-lg)',
            overflow: 'hidden',
          }}
        >
          {orbProjects.length > 0 && (
            <OrbCanvas
              projects={orbProjects}
              onHover={handleHover}
              // Cliquer dans le vide (aucun cluster sous le curseur) relâche.
              onClusterClick={(id) => {
                if (id) toggleFocus(id)
                else releaseFocus()
              }}
              // La scène est reconstruite quand la liste de clusters change :
              // on récupère la nouvelle instance et on lui réapplique le focus
              // courant, sinon l'état React et la caméra divergeraient.
              onReady={(orb) => {
                orbRef.current = orb
                if (focused) orb.focus(focused)
              }}
            />
          )}
          <div
            style={{
              position: 'absolute',
              left: 12,
              top: 12,
              zIndex: 20,
              width: 268,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <BriefPanel summary={briefSummary} time={clock.split(' · ')[1] ?? ''} />
            {focusedProject && <FocusPanel project={focusedProject} onRelease={releaseFocus} />}
          </div>
        </div>

        <div
          style={{
            position: 'absolute',
            right: 20,
            top: 12,
            bottom: 20,
            width: 'clamp(240px, 23vw, 320px)',
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            overflowY: 'auto',
            overflowX: 'hidden',
          }}
        >
          <div style={{ padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div
              style={{
                font: '600 10.5px var(--font-mono)',
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--text-mid)',
                padding: '0 2px 8px',
              }}
            >
              Boucles · le travail en cours
            </div>
            {sortedProjects.map((p) => {
              const badge = badgeFor(p.loop)
              const rowOp = p.loop === 'pause' || p.loop === 'done' ? 0.55 : 1
              const shortLine = `step ${p.step[0]}/${p.step[1]}${p.duree !== '·' ? ` · ${p.duree}` : ''}`
              const isFocused = focused === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggleFocus(p.id)}
                  title={p.line}
                  style={{
                    opacity: rowOp,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 11,
                    padding: '11px 12px',
                    borderRadius: 'var(--r-md)',
                    border: `1px solid ${
                      isFocused
                        ? 'color-mix(in oklab, var(--accent) 45%, transparent)'
                        : 'transparent'
                    }`,
                    background: isFocused
                      ? 'color-mix(in oklab, var(--accent) 9%, transparent)'
                      : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    width: '100%',
                    boxSizing: 'border-box',
                    transition: 'all var(--dur-1) var(--ease)',
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: p.tint ?? 'var(--pause)',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{ font: '500 13.5px var(--font-sans)', color: 'var(--text-hi)' }}
                      >
                        {p.name}
                      </span>
                      <span
                        style={{
                          marginLeft: 'auto',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          font: '10.5px var(--font-mono)',
                          color: 'var(--text-low)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <span
                          style={{
                            width: 5,
                            height: 5,
                            borderRadius: 999,
                            background: badge.color,
                            animation: badge.pulse
                              ? 'chapoPulse 1.8s var(--ease) infinite'
                              : 'none',
                          }}
                        />
                        {badge.label}
                      </span>
                    </span>
                    <span
                      style={{
                        font: '11px var(--font-mono)',
                        color: 'var(--text-low)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {shortLine}
                    </span>
                  </span>
                </button>
              )
            })}
            {sortedProjects.length === 0 && (
              <span
                style={{
                  font: '11.5px var(--font-mono)',
                  color: 'var(--text-low)',
                  padding: '0 2px',
                }}
              >
                aucun projet pour l&rsquo;instant
              </span>
            )}
          </div>

          <div style={{ padding: '10px 2px 4px', marginTop: 'auto' }}>
            <button
              type="button"
              onClick={() => setBudgetOpen((v) => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 2,
              }}
            >
              <span
                style={{
                  font: '600 10.5px var(--font-mono)',
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: 'var(--text-mid)',
                }}
              >
                Budget
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--text-low)',
                  marginLeft: 'auto',
                  transform: `rotate(${budgetOpen ? '0deg' : '-90deg'})`,
                  transition: 'transform var(--dur-2) var(--ease)',
                }}
              >
                ▾
              </span>
            </button>
            {budgetOpen && (
              <div
                style={{ paddingTop: 10, font: '11px var(--font-mono)', color: 'var(--text-low)' }}
              >
                {/* Aucune source réelle cette phase : le suivi budgétaire (fenêtres
                    5h/7j, coûts) arrive en J12 (plan Phase 3, « Hors périmètre »).
                    Mieux vaut le dire que d'inventer un pourcentage. */}
                Suivi budgétaire indisponible pour l&rsquo;instant · prévu en J12.
              </div>
            )}
          </div>
        </div>
      </main>

      <HoverCard project={hover?.project ?? null} left={hover?.left ?? 0} top={hover?.top ?? 0} />
    </>
  )
}

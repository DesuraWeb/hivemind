import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { SEM } from './inbox/constants'

interface PaletteEntry {
  key: string
  label: string
  hint: string
  dot: string
  /** Toujours une des 5 routes réelles de l'app (pas de page Projet/Savoirs cette phase). */
  to: '/inbox' | '/globes'
}

interface PaletteGroup {
  label: string
  items: PaletteEntry[]
}

const PROJECTS_QUERY_KEY = ['projects'] as const
const INBOX_QUERY_KEY = ['inbox'] as const

/**
 * ⌘K (plan Phase 3, Task 8) : recherche projets et inbox, navigation vers
 * les pages — « rien d'autre en v0 » (pas d'Actions statiques, pas de
 * Savoirs : la conscience collective est hors périmètre). Repris de la
 * palette de `MajordomeStrip.dc.html` (chercher `pal` dans le source), sans
 * les groupes qui n'ont pas de contrepartie réelle dans cette phase.
 *
 * Ni les projets ni les items d'inbox n'ont de page de détail cette phase
 * (Projets.dc.html/Projet.dc.html hors périmètre) : sélectionner un résultat
 * ouvre l'Inbox, où l'action réelle a lieu — jamais un lien mort.
 */
export function CommandPalette() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Mêmes clés que Dashboard/Inbox/Globes : réutilise le cache React Query déjà
  // chargé par la page courante plutôt que de refaire la requête à chaque montage.
  const projectsQuery = useQuery({ queryKey: PROJECTS_QUERY_KEY, queryFn: api.projects.list })
  const inboxQuery = useQuery({
    queryKey: INBOX_QUERY_KEY,
    queryFn: () => api.inbox.list({ status: 'open' }),
  })

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => {
          const next = !v
          if (next) {
            setQuery('')
            setIndex(0)
            setTimeout(() => inputRef.current?.focus(), 60)
          }
          return next
        })
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  const groups = useMemo<PaletteGroup[]>(() => {
    const q = query.trim().toLowerCase()
    const match = (label: string, hint: string) =>
      !q || `${label} ${hint}`.toLowerCase().includes(q)

    const projectItems: PaletteEntry[] = (projectsQuery.data ?? [])
      .filter((p) => match(p.name, p.line))
      .slice(0, q ? 6 : 4)
      .map((p) => ({
        key: `p-${p.id}`,
        label: p.name,
        hint: p.line,
        dot: p.tint ?? 'var(--pause)',
        to: '/inbox',
      }))

    const inboxItems: PaletteEntry[] = (inboxQuery.data ?? [])
      .filter((i) => match(i.title, i.agent ?? ''))
      .slice(0, q ? 6 : 4)
      .map((i) => ({
        key: `i-${i.id}`,
        label: i.title,
        hint: i.agent ?? '',
        dot: SEM[i.type],
        to: '/inbox',
      }))

    return [
      { label: 'Projets', items: projectItems },
      { label: 'Inbox', items: inboxItems },
    ].filter((g) => g.items.length > 0 && (q.length > 0 || g.label === 'Projets'))
  }, [query, projectsQuery.data, inboxQuery.data])

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const activeIndex = Math.min(index, Math.max(0, flat.length - 1))

  function go(entry: PaletteEntry) {
    setOpen(false)
    void navigate({ to: entry.to })
  }

  if (!open) return null

  return (
    <>
      <button
        type="button"
        aria-label="Fermer la palette"
        onClick={() => setOpen(false)}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 90,
          background: 'rgba(4, 7, 12, 0.5)',
          border: 'none',
          padding: 0,
          cursor: 'default',
        }}
      />
      <div
        style={{
          position: 'fixed',
          left: '50%',
          top: '15%',
          transform: 'translateX(-50%)',
          zIndex: 91,
          width: 'min(560px, 92vw)',
        }}
      >
        <div
          style={{
            position: 'relative',
            borderRadius: 'var(--r-lg)',
            background: 'var(--glass-bg)',
            backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
            WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
            border: '1px solid rgba(205, 225, 255, 0.07)',
            boxShadow: 'var(--shadow-2)',
            overflow: 'hidden',
          }}
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(i + 1, flat.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter' && flat[activeIndex]) {
                go(flat[activeIndex])
              } else if (e.key === 'Escape') {
                setOpen(false)
              }
            }}
            type="text"
            placeholder="Rechercher · projets, inbox…"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: 'transparent',
              border: 'none',
              borderBottom: '1px solid var(--line)',
              padding: '15px 18px',
              font: '500 14.5px var(--font-sans)',
              color: 'var(--text-hi)',
              outline: 'none',
            }}
          />
          <div style={{ maxHeight: 320, overflowY: 'auto', padding: 8 }}>
            {(() => {
              let k = -1
              return groups.map((g) => (
                <div key={g.label}>
                  <div
                    style={{
                      padding: '8px 10px 4px',
                      font: '600 9.5px var(--font-mono)',
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: 'var(--text-low)',
                    }}
                  >
                    {g.label}
                  </div>
                  {g.items.map((it) => {
                    k += 1
                    const my = k
                    return (
                      <button
                        key={it.key}
                        type="button"
                        onClick={() => go(it)}
                        onMouseEnter={() => setIndex(my)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          width: '100%',
                          padding: '9px 10px',
                          borderRadius: 'var(--r-md)',
                          border: 'none',
                          textAlign: 'left',
                          background:
                            my === activeIndex
                              ? 'color-mix(in oklab, var(--accent) 12%, transparent)'
                              : 'transparent',
                          cursor: 'pointer',
                        }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 999,
                            background: it.dot,
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            font: '500 13px var(--font-sans)',
                            color: 'var(--text-hi)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {it.label}
                        </span>
                        <span
                          style={{
                            marginLeft: 'auto',
                            font: '10px var(--font-mono)',
                            color: 'var(--text-low)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {it.hint}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            })()}
            {flat.length === 0 && (
              <div
                style={{
                  padding: 18,
                  font: '11px var(--font-mono)',
                  color: 'var(--text-low)',
                  textAlign: 'center',
                }}
              >
                aucun résultat
              </div>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 16,
              padding: '9px 14px',
              borderTop: '1px solid var(--line)',
              font: '10px var(--font-mono)',
              color: 'var(--text-low)',
            }}
          >
            <span>↑↓ naviguer</span>
            <span>entrée ouvrir</span>
            <span>esc fermer</span>
          </div>
          <div className="hive-ring" />
        </div>
      </div>
    </>
  )
}

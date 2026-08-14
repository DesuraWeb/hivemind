import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { SEM } from './inbox/constants'

/**
 * Destination d'un résultat. Un type somme plutôt qu'un simple chemin : la
 * fiche projet est une route paramétrée, elle a besoin de ses deux slugs.
 */
type PaletteTarget =
  | { kind: 'inbox' }
  | { kind: 'project'; globeId: string; projectId: string }
  /** Une page sans paramètre : les entrées du groupe Actions. */
  | { kind: 'route'; to: string }

interface PaletteEntry {
  key: string
  label: string
  hint: string
  dot: string
  target: PaletteTarget
}

interface PaletteGroup {
  label: string
  items: PaletteEntry[]
}

/**
 * Les destinations du groupe Actions. Reprises de `MajordomeStrip.dc.html`
 * (chercher `pal` dans le source), **moins celles dont la page n'existe pas**.
 *
 * « Suivre le run en direct » n'y figure pas : le prototype l'attache à un run
 * précis, et une palette ne sait pas lequel. L'entrée vit sur le panneau de
 * focus du dashboard, là où le projet est connu.
 */
const ACTIONS: { label: string; hint: string; to: string }[] = [
  { label: 'Démarrer la revue du matin', hint: 'traitement au clavier', to: '/revue' },
  { label: 'Journal · nuit des agents et vos décisions', hint: 'fusionné', to: '/journal' },
  { label: 'Analytics · coûts', hint: 'économie du système', to: '/analytics' },
  { label: 'Créer un projet ou un globe', hint: 'scène de création', to: '/creation' },
  { label: 'Mode ambient', hint: 'écran TV', to: '/ambient' },
  { label: 'Conscience collective', hint: 'spec mémoire', to: '/conscience' },
  { label: 'Protocole inter-agents', hint: 'spec passations', to: '/protocole' },
  { label: 'Réglages', hint: 'diagnostic, budget, coffre', to: '/reglages' },
  { label: 'Clients', hint: 'base de connaissances', to: '/clients' },
  { label: 'Globes', hint: 'espaces de conscience', to: '/globes' },
  // Sans cette entrée, l'écran n'est atteignable qu'en tapant son URL : il n'a
  // ni redirection au premier lancement (rien côté serveur ne dit qu'une
  // instance est neuve) ni place dans le rail.
  { label: 'Mise en route de l’instance', hint: 'runtime, intégrations', to: '/onboarding' },
]

const PROJECTS_QUERY_KEY = ['projects'] as const
const INBOX_QUERY_KEY = ['inbox'] as const

/**
 * ⌘K : recherche projets et inbox, plus le groupe **Actions** — l'index de
 * toutes les pages, comme l'exige CLAUDE.md.
 *
 * Ce groupe avait été écarté « en v0 » pour une raison qui a cessé d'être
 * vraie : les écrans n'existaient pas, et une palette qui propose des
 * destinations inexistantes est pire qu'une palette courte. Ils existent
 * maintenant. Une action dont la page n'est pas construite n'entre PAS dans
 * la liste — c'est la même règle que partout : on ne propose pas ce qu'on ne
 * sait pas faire.
 *
 * Le groupe **Savoirs** du prototype reste absent : la conscience collective
 * n'a ni table ni API, il n'y a rien à indexer.
 *
 * Un résultat « projet » ouvre désormais sa fiche (`/globes/:globe/:projet`)
 * plutôt que l'Inbox : le repli sur `/inbox` datait de l'absence de page
 * projet, il n'a plus lieu d'être. Les items d'inbox, eux, continuent d'ouvrir
 * l'Inbox — c'est là que l'action a lieu.
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
        target: { kind: 'project', globeId: p.globe, projectId: p.id },
      }))

    const inboxItems: PaletteEntry[] = (inboxQuery.data ?? [])
      .filter((i) => match(i.title, i.agent ?? ''))
      .slice(0, q ? 6 : 4)
      .map((i) => ({
        key: `i-${i.id}`,
        label: i.title,
        hint: i.agent ?? '',
        dot: SEM[i.type],
        target: { kind: 'inbox' },
      }))

    const actionItems: PaletteEntry[] = ACTIONS.filter((a) => match(a.label, a.hint))
      .slice(0, q ? 8 : 5)
      .map((a) => ({
        key: `a-${a.to}`,
        label: a.label,
        hint: a.hint,
        dot: 'var(--accent)',
        target: { kind: 'route', to: a.to },
      }))

    return [
      { label: 'Projets', items: projectItems },
      { label: 'Actions', items: actionItems },
      { label: 'Inbox', items: inboxItems },
      // Sans recherche, on ne montre que les deux groupes qui servent à
      // démarrer quelque chose ; l'inbox se cherche, elle ne se parcourt pas ici.
    ].filter((g) => g.items.length > 0 && (q.length > 0 || g.label !== 'Inbox'))
  }, [query, projectsQuery.data, inboxQuery.data])

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const activeIndex = Math.min(index, Math.max(0, flat.length - 1))

  function go(entry: PaletteEntry) {
    setOpen(false)
    if (entry.target.kind === 'project') {
      void navigate({
        to: '/globes/$globeId/$projectId',
        params: { globeId: entry.target.globeId, projectId: entry.target.projectId },
      })
      return
    }
    if (entry.target.kind === 'route') {
      void navigate({ to: entry.target.to })
      return
    }
    void navigate({ to: '/inbox' })
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

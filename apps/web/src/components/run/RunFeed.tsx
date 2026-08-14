import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type FeedEntry, feedTime } from './feed'

/** Au-delà, le corps est replié : les prompts de cadrage font plusieurs milliers de signes. */
const CLAMP_CHARS = 260

/**
 * Le flux d'événements (`main` du pack) : heure, pastille de couleur du rôle,
 * auteur, nature du message, corps.
 *
 * Les corps ne sont pas tronqués pour de bon — un rapport de reviewer replié
 * puis dépliable vaut mieux qu'un rapport coupé au milieu d'une phrase, et
 * c'est la seule matière qu'on ait pour comprendre ce qui se passe dans la
 * boucle.
 *
 * Le défilement suit le bas du flux tant que l'utilisateur y est ; dès qu'il
 * remonte lire quelque chose, l'arrivée d'un message ne le ramène plus en bas.
 */
export function RunFeed({
  entries,
  empty,
  banner,
}: {
  entries: FeedEntry[]
  /** Ce qu'on affiche quand aucune passation n'a encore été écrite. */
  empty: ReactNode
  /** Bandeau de fin de run (arrêt, échec, succès), rendu sous le dernier événement. */
  banner?: ReactNode
}) {
  const scrollRef = useRef<HTMLElement>(null)
  const stickToBottom = useRef(true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  // La clé du dernier événement plutôt que leur nombre : c'est l'arrivée d'une
  // passation qui doit ramener en bas, et deux listes de même longueur ne sont
  // pas la même liste (un rechargement peut en remplacer le contenu).
  const lastKey = entries.at(-1)?.key ?? ''
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current && lastKey !== '') el.scrollTop = el.scrollHeight
  }, [lastKey])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <main
      ref={scrollRef}
      onScroll={onScroll}
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 26px 16px' }}
    >
      <div
        style={{
          maxWidth: 720,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 13,
        }}
      >
        {entries.length === 0 && empty}

        {entries.map((e) => {
          const isLong = e.body.length > CLAMP_CHARS
          const isOpen = expanded.has(e.key)
          return (
            <div key={e.key} style={{ display: 'flex', gap: 14 }}>
              <span
                style={{
                  width: 46,
                  flexShrink: 0,
                  textAlign: 'right',
                  font: '10.5px var(--font-mono)',
                  color: 'var(--text-low)',
                  paddingTop: 2,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {feedTime(e.at)}
              </span>
              <span
                style={{
                  width: 8,
                  height: 8,
                  flexShrink: 0,
                  borderRadius: 999,
                  background: e.color,
                  marginTop: 4,
                  boxShadow: `0 0 8px color-mix(in oklab, ${e.color} 30%, transparent)`,
                }}
              />
              <span
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  minWidth: 0,
                  flex: 1,
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 9,
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{ font: '600 11.5px var(--font-sans)', color: e.color }}>
                    {e.who}
                  </span>
                  <span style={{ font: '10px var(--font-mono)', color: 'var(--text-low)' }}>
                    {e.note}
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 13.5,
                    fontWeight: 500,
                    color: 'var(--text-hi)',
                    lineHeight: 1.5,
                    textWrap: 'pretty',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    ...(isLong && !isOpen
                      ? {
                          display: '-webkit-box',
                          WebkitBoxOrient: 'vertical' as const,
                          WebkitLineClamp: 4,
                          overflow: 'hidden',
                        }
                      : {}),
                  }}
                >
                  {e.body}
                </span>
                {isLong && (
                  <button
                    type="button"
                    onClick={() => toggle(e.key)}
                    style={{
                      alignSelf: 'flex-start',
                      marginTop: 2,
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--accent)',
                      font: '10.5px var(--font-mono)',
                      cursor: 'pointer',
                    }}
                  >
                    {isOpen ? 'replier' : 'déplier'}
                  </button>
                )}
              </span>
            </div>
          )
        })}

        {banner}
      </div>
    </main>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { OscilloscopeInstance } from '../vendor/oscilloscope'
import { create as createOscilloscope } from '../vendor/oscilloscope'

// HiveStrip = reprise React de MajordomeStrip.dc.html (le fichier du pack
// garde son nom, CLAUDE.md : « HIVE » partout dans l'UI, le composant React
// s'appelle HiveStrip). Ne porte ici que le socle : oscilloscope, micro rond,
// champ pilule. Le fil de conversation et la palette ⌘K arrivent à la Task 8
// — volontairement absents.
export function HiveStrip() {
  const oscContainerRef = useRef<HTMLDivElement>(null)
  const oscRef = useRef<OscilloscopeInstance | null>(null)
  const [mic, setMic] = useState(false)
  const [text, setText] = useState('')

  useEffect(() => {
    const container = oscContainerRef.current
    if (!container) return
    const osc = createOscilloscope(container, { state: 'idle' })
    oscRef.current = osc
    return () => {
      osc.destroy()
      oscRef.current = null
    }
  }, [])

  function toggleMic() {
    const next = !mic
    setMic(next)
    oscRef.current?.setState(next ? 'listen' : 'idle')
  }

  const micBorder = mic ? 'transparent' : 'var(--glass-border)'
  const micBackground = mic ? 'var(--accent)' : 'var(--glass-bg)'
  const micColor = mic ? 'var(--accent-ink)' : 'var(--text-mid)'

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        width: 'min(480px, 92%)',
        margin: '0 auto',
        pointerEvents: 'auto',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div ref={oscContainerRef} style={{ width: '72%', maxWidth: 340, height: 36 }} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          justifyContent: 'center',
          boxSizing: 'border-box',
          paddingRight: 60,
        }}
      >
        <button
          type="button"
          onClick={toggleMic}
          title="Parler à Hive"
          aria-pressed={mic}
          className="hive-mic-btn"
          style={{
            width: 50,
            height: 50,
            flexShrink: 0,
            borderRadius: 999,
            border: `1px solid ${micBorder}`,
            background: micBackground,
            color: micColor,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all var(--dur-2) var(--ease)',
          }}
        >
          <svg width="19" height="19" viewBox="0 0 17 17" fill="none" aria-hidden="true">
            <rect
              x="6"
              y="1.8"
              width="5"
              height="8.4"
              rx="2.5"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path
              d="M3.4 8.2a5.1 5.1 0 0 0 10.2 0M8.5 13.3v2"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          type="text"
          placeholder="ou écrivez à Hive…"
          aria-label="Écrire à Hive"
          className="hive-input"
          style={{
            flex: 1,
            minWidth: 0,
            maxWidth: 340,
            background: 'rgba(9, 14, 22, 0.75)',
            border: '1px solid var(--line-strong)',
            borderRadius: 'var(--r-full)',
            padding: '12px 19px',
            font: '500 13.5px var(--font-sans)',
            color: 'var(--text-hi)',
            outline: 'none',
            transition: 'all var(--dur-1) var(--ease)',
          }}
        />
      </div>
    </div>
  )
}

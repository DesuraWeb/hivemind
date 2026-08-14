import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { OscilloscopeInstance } from '../vendor/oscilloscope'
import { create as createOscilloscope } from '../vendor/oscilloscope'
import { CommandPalette } from './CommandPalette'
import { HiveThread } from './hive/HiveThread'

// HiveStrip = reprise React de MajordomeStrip.dc.html (le fichier du pack
// garde son nom, CLAUDE.md : « HIVE » partout dans l'UI, le composant React
// s'appelle HiveStrip). Porte le socle (oscilloscope, micro rond, champ
// pilule) + la palette ⌘K (CommandPalette) + le fil de conversation ancré
// au-dessus.
//
// Le fil parle vraiment à Hive (`POST /api/hive/messages`, rôle `majordome`).
// Deux choses en découlent, visibles dans le code ci-dessous :
//
// - Un envoi COÛTE des tokens. Il ne part donc que sur un geste explicite —
//   Entrée ou le bouton — jamais à la frappe, jamais au focus. C'est la même
//   règle que le bouton « Optimiser » de l'inbox.
// - Le message est enregistré côté serveur AVANT l'appel au modèle. Si Hive
//   échoue, on dit que la réponse a échoué, pas que la question s'est perdue.
export function HiveStrip() {
  const oscContainerRef = useRef<HTMLDivElement>(null)
  const oscRef = useRef<OscilloscopeInstance | null>(null)
  const [mic, setMic] = useState(false)
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [closedByUser, setClosedByUser] = useState(false)
  const queryClient = useQueryClient()

  // Le fil n'est chargé que lorsqu'il est ouvert : sur toutes les pages, une
  // requête permanente pour un panneau replié serait du trafic pour rien.
  const { data: messages } = useQuery({
    queryKey: ['hive', 'messages'],
    queryFn: api.hive.messages,
    enabled: open,
  })

  const ask = useMutation({
    mutationFn: api.hive.ask,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['hive', 'messages'] }),
    // Le message part quand même en base côté serveur : on recharge pour le
    // voir apparaître, même quand la réponse a échoué.
    onError: () => queryClient.invalidateQueries({ queryKey: ['hive', 'messages'] }),
  })

  function send() {
    const value = text.trim()
    if (!value || ask.isPending) return
    setText('')
    setOpen(true)
    setClosedByUser(false)
    ask.mutate(value)
  }

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
      <CommandPalette />
      <HiveThread
        open={open}
        messages={messages ?? []}
        pending={ask.isPending}
        error={ask.isError ? 'Hive est injoignable' : null}
        onClose={() => {
          setOpen(false)
          setClosedByUser(true)
        }}
      />
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
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
          // Rouvre le fil replié, sauf s'il n'y a rien à montrer : ouvrir un
          // panneau vide au premier clic dans le champ serait du bruit.
          onFocus={() => {
            if (closedByUser && (messages?.length ?? 0) > 0) setOpen(true)
          }}
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

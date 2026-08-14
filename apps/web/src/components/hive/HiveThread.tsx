import { useEffect, useRef } from 'react'
import type { HiveMessageView } from '../../lib/api'

/**
 * Le fil de conversation avec Hive, ancré AU-DESSUS du bandeau
 * (`MajordomeStrip.dc.html`, l. 42-72).
 *
 * Il s'ouvre au premier échange, se replie à la croix, se rouvre au focus du
 * champ — c'est le comportement du prototype, et il évite qu'un panneau vide
 * flotte en permanence sur toutes les pages.
 *
 * Le liseré orbitant est le même que celui de la palette ⌘K (`hive-ring` dans
 * `global.css`, `@property --hive-angle` + `hiveOrbit 5s`) : il existait déjà,
 * appliqué à un seul composant. CLAUDE.md est explicite sur sa forme — conic
 * gradient sur l'accent UNIQUEMENT, anneau de 1,5 px, **pas de halo flouté
 * extérieur**, retiré à la demande de Florian.
 */

export interface HiveThreadProps {
  open: boolean
  messages: HiveMessageView[]
  /** Vrai pendant l'aller-retour : Hive répond, on le montre plutôt que de figer. */
  pending: boolean
  /** Message d'erreur si l'échange a échoué. La question, elle, est déjà enregistrée. */
  error: string | null
  onClose: () => void
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

export function HiveThread({ open, messages, pending, error, onClose }: HiveThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Le fil se lit par le bas : une réponse qui arrive hors champ n'a pas été
  // reçue, du point de vue de celui qui attend.
  useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [open])

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 10px)',
        left: '50%',
        transform: `translateX(-50%) translateY(${open ? '0' : '8px'})`,
        width: 'min(460px, 100%)',
        zIndex: 5,
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity var(--dur-3) var(--ease), transform var(--dur-3) var(--ease-out)',
      }}
    >
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 'var(--r-lg)',
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
          WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
          border: '1px solid rgba(205, 225, 255, 0.07)',
          boxShadow: 'var(--shadow-2)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 999,
              background:
                'radial-gradient(circle at 35% 30%, color-mix(in oklab, var(--accent) 85%, white), var(--accent) 45%, transparent)',
              boxShadow: '0 0 8px var(--accent-glow)',
            }}
          />
          <span style={{ font: '600 12.5px var(--font-sans)', color: 'var(--text-hi)' }}>Hive</span>
          <span style={{ font: '10px var(--font-mono)', color: 'var(--ok)' }}>● en ligne</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Replier le fil"
            style={{
              marginLeft: 'auto',
              width: 22,
              height: 22,
              borderRadius: 'var(--r-sm)',
              border: 'none',
              background: 'transparent',
              color: 'var(--text-mid)',
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <div
          ref={scrollRef}
          style={{
            maxHeight: 280,
            overflowY: 'auto',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {messages.map((m) => {
            const mine = m.from !== 'majordome'
            return (
              <div
                key={m.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  alignItems: mine ? 'flex-end' : 'flex-start',
                }}
              >
                <span style={{ font: '10px var(--font-mono)', color: 'var(--text-low)' }}>
                  {mine ? 'Vous' : 'Hive'} · {time(m.at)}
                </span>
                <div
                  style={{
                    maxWidth: '88%',
                    padding: '8px 12px',
                    borderRadius: 11,
                    background: mine
                      ? 'color-mix(in oklab, var(--accent) 12%, transparent)'
                      : 'rgba(214, 228, 247, 0.04)',
                    border: mine
                      ? '1px solid color-mix(in oklab, var(--accent) 28%, transparent)'
                      : '1px solid var(--line)',
                    fontSize: 12.5,
                    fontWeight: 500,
                    lineHeight: 1.5,
                    color: 'var(--text-hi)',
                    textWrap: 'pretty',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {m.body}
                </div>
              </div>
            )
          })}

          {pending && (
            <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
              Hive réfléchit…
            </span>
          )}

          {/* La question de Florian est déjà enregistrée côté serveur : on dit
              que la RÉPONSE a échoué, jamais que la question s'est perdue. */}
          {error && (
            <span style={{ font: '10.5px var(--font-mono)', color: 'var(--sem-alert)' }}>
              {error} · votre message est enregistré
            </span>
          )}

          {messages.length === 0 && !pending && (
            <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
              Hive voit l&rsquo;état du parc et l&rsquo;inbox · posez-lui une question.
            </span>
          )}
        </div>
      </div>

      {/* Liseré orbitant, identique à celui de la palette ⌘K. */}
      <div className="hive-ring" />
    </div>
  )
}

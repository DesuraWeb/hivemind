import { useEffect, useState } from 'react'

function parts(now: Date): { time: string; date: string } {
  return {
    time: now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    date: now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
  }
}

/**
 * L'heure en gros mono, la date en dessous (`Ambient.dc.html`, coin haut
 * gauche). Rafraîchie toutes les 5 s comme le prototype : l'affichage est à la
 * minute, une seconde de retard ne se voit pas et l'écran tourne des heures.
 */
export function AmbientClock() {
  const [now, setNow] = useState(() => parts(new Date()))
  useEffect(() => {
    const id = setInterval(() => setNow(parts(new Date())), 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <div
      style={{
        position: 'absolute',
        left: 40,
        top: 34,
        zIndex: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          font: '600 54px var(--font-mono)',
          letterSpacing: '-0.01em',
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {now.time}
      </span>
      <span
        style={{
          font: '12px var(--font-mono)',
          color: 'var(--text-low)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
        }}
      >
        {now.date}
      </span>
    </div>
  )
}

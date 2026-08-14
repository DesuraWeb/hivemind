import type { CSSProperties, ReactNode } from 'react'

/**
 * Le gabarit commun de l'écran Réglages (`docs/design/Reglages.dc.html`) :
 * une surface de verre sans bordure (« Réglages = diagnostic mono sans
 * cadres », CLAUDE.md), un label mono petites caps, et de quoi poser un geste
 * à droite du label.
 */
export function Panel({
  label,
  right,
  children,
}: {
  label: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      style={{
        borderRadius: 'var(--r-lg)',
        background: 'rgba(13, 20, 32, 0.55)',
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          style={{
            font: '600 10.5px var(--font-mono)',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--text-mid)',
          }}
        >
          {label}
        </span>
        {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
      </div>
      {children}
    </section>
  )
}

/** Ligne de diagnostic en mono, avec sa pastille d'état. */
export function StatusLine({
  color,
  children,
}: {
  /** Token de couleur de la pastille. `--text-low` quand l'état n'est pas connu. */
  color: string
  children: ReactNode
}) {
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 9,
        font: '12px var(--font-mono)',
        color: 'var(--text-mid)',
        lineHeight: 1.9,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          flexShrink: 0,
          borderRadius: 999,
          background: color,
          transform: 'translateY(-1px)',
        }}
      />
      <span style={{ minWidth: 0 }}>{children}</span>
    </span>
  )
}

/** Annotation basse : ce qui manque, ce qui ne se règle pas d'ici, ce qui coûte. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)', lineHeight: 1.8 }}>
      {children}
    </span>
  )
}

/** Bouton fantôme du pack : bordure fine, jamais de fond plein. */
export const GHOST_BUTTON: CSSProperties = {
  padding: '6px 12px',
  borderRadius: 'var(--r-md)',
  border: '1px solid var(--line-strong)',
  background: 'transparent',
  color: 'var(--text-hi)',
  font: '500 12px var(--font-sans)',
  cursor: 'pointer',
}

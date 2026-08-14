import type { ReactNode } from 'react'
import { useHover } from '../inbox/useHover'

/**
 * Pièces communes aux deux onglets du Journal (`docs/design/Journal.dc.html`).
 *
 * Le rail : les deux onglets partagent exactement la même gouttière
 * (`padding-left: 92px`, filet dégradé à `left: 74px`, heure à `-92px` sur
 * 58 px, pastille à `-22px`). Une seule implémentation, deux usages — le
 * prototype la recopie deux fois parce qu'il n'a pas de composants.
 */

export function Rail({ children, gap = 22 }: { children: ReactNode; gap?: number }) {
  return (
    <div style={{ position: 'relative', paddingLeft: 92 }}>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 74,
          top: 6,
          bottom: 6,
          width: 1,
          background:
            'linear-gradient(180deg, transparent, var(--line-strong) 12%, var(--line-strong) 88%, transparent)',
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap }}>{children}</div>
    </div>
  )
}

export function RailRow({
  time,
  dot,
  children,
}: {
  time: string
  /** Couleur de la pastille : rôle émetteur (nuit) ou type d'item (décisions). */
  dot: string
  children: ReactNode
}) {
  return (
    <div style={{ position: 'relative' }}>
      <span
        style={{
          position: 'absolute',
          left: -92,
          top: 2,
          width: 58,
          textAlign: 'right',
          font: '11px var(--font-mono)',
          color: 'var(--text-low)',
        }}
      >
        {time}
      </span>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: -22,
          top: 5,
          width: 9,
          height: 9,
          borderRadius: 999,
          background: dot,
          boxShadow: `0 0 10px color-mix(in oklab, ${dot} 30%, transparent)`,
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  )
}

/** Ligne de méta d'une entrée : rôle/type coloré à gauche, contexte mono, appoint à droite. */
export function RowMeta({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
      {children}
    </div>
  )
}

export function RowText({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 13.5,
        fontWeight: 500,
        color: 'var(--text-hi)',
        lineHeight: 1.5,
        textWrap: 'pretty',
      }}
    >
      {children}
    </div>
  )
}

/** Le pied de page mono d'un onglet (rétention, ce que l'écran ne sait pas faire). */
export function FootNote({ children }: { children: ReactNode }) {
  return (
    <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)', lineHeight: 1.7 }}>
      {children}
    </span>
  )
}

/**
 * Bouton pilule du segmented control (onglets) et du sélecteur de fenêtre.
 * Même géométrie que le prototype : `padding: 5px 14px`, `--r-full`, bordure
 * et fond en `color-mix` de l'accent quand il est actif.
 */
export function Pill({
  label,
  active,
  onClick,
  compact = false,
}: {
  label: string
  active: boolean
  onClick: () => void
  compact?: boolean
}) {
  const [hover, hoverProps] = useHover()
  return (
    <button
      type="button"
      onClick={onClick}
      {...hoverProps}
      style={{
        padding: compact ? '4px 11px' : '5px 14px',
        borderRadius: 'var(--r-full)',
        border: `1px solid ${
          active
            ? 'color-mix(in oklab, var(--accent) 45%, transparent)'
            : hover
              ? 'var(--line-strong)'
              : 'transparent'
        }`,
        background: active ? 'color-mix(in oklab, var(--accent) 13%, transparent)' : 'transparent',
        color: active ? 'var(--text-hi)' : 'var(--text-mid)',
        font: '500 12px var(--font-sans)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'all var(--dur-1) var(--ease)',
      }}
    >
      {label}
    </button>
  )
}

/** Le groupe de pilules dans son étui (fond sombre + bordure fine) du prototype. */
export function PillGroup({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: 3,
        borderRadius: 'var(--r-full)',
        background: 'rgba(9, 14, 22, 0.6)',
        border: '1px solid var(--line)',
      }}
    >
      {children}
    </div>
  )
}

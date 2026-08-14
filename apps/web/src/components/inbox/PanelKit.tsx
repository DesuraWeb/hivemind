import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'
import { useHover } from './useHover'
import { useIsMobile } from './useIsMobile'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BASE: CSSProperties = {
  borderRadius: 'var(--r-md)',
  font: '500 13px var(--font-sans)',
  cursor: 'pointer',
  transition: 'all var(--dur-1) var(--ease)',
}

function variantStyle(variant: Variant, hover: boolean): CSSProperties {
  switch (variant) {
    case 'primary':
      return {
        padding: '9px 18px',
        border: '1px solid transparent',
        background: 'var(--accent)',
        color: 'var(--accent-ink)',
        filter: hover ? 'brightness(1.08)' : 'none',
      }
    case 'secondary':
      return {
        padding: '9px 16px',
        border: '1px solid var(--line-strong)',
        background: 'transparent',
        color: 'var(--text-hi)',
        borderColor: hover
          ? 'color-mix(in oklab, var(--accent) 50%, transparent)'
          : 'var(--line-strong)',
      }
    case 'ghost':
      return {
        padding: '9px 16px',
        border: '1px solid transparent',
        background: 'transparent',
        color: hover ? 'var(--text-hi)' : 'var(--text-mid)',
      }
    case 'danger':
      return {
        padding: '9px 16px',
        border: '1px solid color-mix(in oklab, var(--sem-alert) 40%, transparent)',
        background: hover
          ? 'color-mix(in oklab, var(--sem-alert) 12%, transparent)'
          : 'transparent',
        color: 'var(--sem-alert)',
      }
  }
}

interface PanelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  children: ReactNode
}

export function PanelButton({ variant = 'secondary', style, children, ...rest }: PanelButtonProps) {
  const [hover, hoverProps] = useHover()
  // Au pouce, une cible de 33px de haut (9px de padding + 13px de texte) se
  // rate. 44px est le plancher tenu par tout l'écran mobile (`Inbox
  // mobile.dc.html` : `min-height: 44px` sur chaque bouton de la feuille) ;
  // au-dessus du point de bascule, rien ne change.
  const mobile = useIsMobile()
  const touch: CSSProperties = mobile
    ? { minHeight: 44, paddingLeft: 18, paddingRight: 18, fontSize: 13.5 }
    : {}
  return (
    <button
      // Marque l'action principale du panneau pour qui pilote au clavier : la
      // Revue du matin (routes/RevueMatin.tsx) mappe « entrée » dessus sans
      // rien savoir du type d'item ni de l'état local du panneau (texte tapé,
      // corps d'email édité…), qui reste la propriété du panneau. Sans repère,
      // il faudrait dupliquer une action principale par type ici.
      {...(variant === 'primary' ? { 'data-panel-primary': 'true' } : {})}
      type="button"
      {...hoverProps}
      {...rest}
      style={{ ...BASE, ...variantStyle(variant, hover), ...touch, ...style }}
    >
      {children}
    </button>
  )
}

export function PanelActions({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{children}</div>
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        font: '600 10px var(--font-sans)',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--text-low)',
      }}
    >
      {children}
    </span>
  )
}

export function CtxLine({ children }: { children: ReactNode }) {
  return <div style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>{children}</div>
}

export const textareaStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  resize: 'vertical',
  background: 'rgba(9, 14, 22, 0.65)',
  border: '1px solid var(--line-strong)',
  borderRadius: 'var(--r-md)',
  padding: '11px 13px',
  font: '500 13.5px var(--font-sans)',
  color: 'var(--text-hi)',
  outline: 'none',
  lineHeight: 1.6,
}

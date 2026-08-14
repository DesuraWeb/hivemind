import type { CSSProperties, ReactNode } from 'react'

/**
 * Les styles partagés des fragments de la scène de création, repris au pixel
 * de `docs/design/Creation.dc.html`. Les états `:focus` / `:hover` vivent en
 * classes (`global.css`, préfixe `creation-`) : un style inline React ne sait
 * pas les porter.
 */

export const FRAGMENT_LABEL: CSSProperties = {
  font: '600 11px var(--font-mono)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--text-mid)',
}

export const FIELD_LABEL: CSSProperties = {
  font: '10.5px var(--font-mono)',
  color: 'var(--text-low)',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
}

export const GLASS_CARD: CSSProperties = {
  borderRadius: 'var(--r-lg)',
  background: 'var(--glass-bg)',
  backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
  WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
  border: '1px solid var(--glass-border)',
  boxShadow: 'var(--shadow-2), inset 0 1px 0 rgba(255, 255, 255, 0.10)',
}

export const GLASS_ROW: CSSProperties = {
  borderRadius: 'var(--r-md)',
  background: 'var(--glass-bg)',
  backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
  WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
  border: '1px solid var(--glass-border)',
  boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.08)',
}

/** Champ souligné de la fiche Identité (pack : bordure basse seule). */
export const UNDERLINE_INPUT: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--line)',
  padding: '4px 0',
  font: '500 14px var(--font-sans)',
  color: 'var(--text-hi)',
  outline: 'none',
}

export const MONO_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  font: '12px var(--font-mono)',
  color: 'var(--text-mid)',
}

/**
 * Étiquette au-dessus de son champ. `htmlFor` explicite plutôt qu'un champ
 * enveloppé : le linter d'accessibilité ne sait pas voir un `<input>` passé en
 * `children`, et l'association reste vraie même si la mise en page bouge.
 */
export function Field({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: ReactNode
}) {
  return (
    <label htmlFor={id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={FIELD_LABEL}>{label}</span>
      {children}
    </label>
  )
}

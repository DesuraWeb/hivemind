import type { ReactNode } from 'react'
import { useHover } from '../inbox/useHover'

/**
 * Pièces de l'écran Analytics (`docs/design/Analytics.dc.html`) : grands
 * nombres, pilules de fenêtre, labels de section.
 */

/** Format monétaire du pack : « 31,20 € » (virgule décimale, deux décimales). */
export function formatEur(eur: number): string {
  return `${eur.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

/** « 172 k », « 1,4 M », « 840 » — l'ordre de grandeur du pack, jamais le chiffre brut à 9 chiffres. */
export function formatTokensShort(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000).toLocaleString('fr-FR')} k`
  return tokens.toLocaleString('fr-FR')
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        font: '600 10.5px var(--font-mono)',
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: 'var(--text-mid)',
      }}
    >
      {children}
    </span>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)', lineHeight: 1.7 }}>
      {children}
    </span>
  )
}

/** Un grand nombre et sa légende (`42px`, `letter-spacing: -0.02em`, chiffres tabulaires). */
export function Stat({
  value,
  label,
  accent = false,
}: {
  value: string
  label: ReactNode
  accent?: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          font: '600 42px var(--font-sans)',
          letterSpacing: '-0.02em',
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
          ...(accent ? { color: 'var(--accent)' } : {}),
        }}
      >
        {value}
      </span>
      <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>{label}</span>
    </div>
  )
}

/**
 * Le même emplacement, pour une grandeur qu'on ne mesure pas. Le champ est
 * **nommé comme manquant** — jamais rendu à zéro, jamais rempli d'une
 * estimation qui donnerait à un chiffre inventé l'autorité des deux autres.
 */
export function MissingStat({ label, why }: { label: string; why: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignSelf: 'flex-end' }}>
      <span
        style={{
          font: '500 18px var(--font-mono)',
          lineHeight: 1.2,
          color: 'var(--text-low)',
        }}
      >
        non mesuré
      </span>
      <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
        {label}
        <br />
        {why}
      </span>
    </div>
  )
}

/** Pilule de fenêtre d'`Analytics.dc.html` : bordure `--line-strong` au repos, accent quand active. */
export function RangeButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  const [hover, hoverProps] = useHover()
  return (
    <button
      type="button"
      onClick={onClick}
      {...hoverProps}
      style={{
        padding: '5px 13px',
        borderRadius: 'var(--r-full)',
        border: `1px solid ${
          active ? 'color-mix(in oklab, var(--accent) 45%, transparent)' : 'var(--line-strong)'
        }`,
        background: active
          ? 'color-mix(in oklab, var(--accent) 12%, transparent)'
          : hover
            ? 'rgba(214, 228, 247, 0.04)'
            : 'transparent',
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

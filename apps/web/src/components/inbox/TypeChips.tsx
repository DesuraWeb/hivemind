import type { InboxType } from '@silithid/shared'
import { SEM, TYPE_CHIP_DEFS } from './constants'
import { useHover } from './useHover'
import { useIsMobile } from './useIsMobile'

export interface TypeChipsProps {
  counts: Record<'all' | InboxType, number>
  active: 'all' | InboxType
  onPick: (id: 'all' | InboxType) => void
}

function Chip({
  id,
  label,
  count,
  active,
  onPick,
}: {
  id: 'all' | InboxType
  label: string
  count: number
  active: boolean
  onPick: (id: 'all' | InboxType) => void
}) {
  const [hover, hoverProps] = useHover()
  const mobile = useIsMobile()
  const dot = id === 'all' ? null : SEM[id]
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      {...hoverProps}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        // Au pouce : 44px de haut et pas de retour à la ligne, la rangée
        // défile latéralement (`Inbox mobile.dc.html`, `overflow-x: auto`).
        minHeight: mobile ? 44 : undefined,
        flexShrink: mobile ? 0 : undefined,
        padding: mobile ? '8px 14px' : '5px 12px',
        borderRadius: 'var(--r-full)',
        border: `1px solid ${active ? 'color-mix(in oklab, var(--accent) 45%, transparent)' : hover ? 'var(--line-strong)' : 'transparent'}`,
        background: active ? 'color-mix(in oklab, var(--accent) 13%, transparent)' : 'transparent',
        font: '500 12px var(--font-sans)',
        color: active ? 'var(--text-hi)' : 'var(--text-mid)',
        cursor: 'pointer',
        transition: 'all var(--dur-1) var(--ease)',
      }}
    >
      {dot && (
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: 999, background: dot }}
        />
      )}
      <span>{label}</span>
      <span style={{ font: '500 11px var(--font-mono)', color: 'var(--text-low)' }}>{count}</span>
    </button>
  )
}

export function TypeChips({ counts, active, onPick }: TypeChipsProps) {
  const mobile = useIsMobile()
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: mobile ? 'nowrap' : 'wrap',
        overflowX: mobile ? 'auto' : 'visible',
        gap: 7,
        padding: '2px 2px 12px',
      }}
    >
      {TYPE_CHIP_DEFS.map(({ id, label }) => (
        <Chip
          key={id}
          id={id}
          label={label}
          count={counts[id]}
          active={active === id}
          onPick={onPick}
        />
      ))}
    </div>
  )
}

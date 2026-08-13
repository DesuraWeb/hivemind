import { useState } from 'react'
import { formatAge } from '../../lib/age'
import type { InboxItemView } from '../../lib/inbox-types'
import { shortId } from './constants'
import { useHover } from './useHover'

export interface SavoirGroupProps {
  items: InboxItemView[]
  selectedId: string | null
  onPickItem: (id: string) => void
  projectName: (slug: string | null) => string
}

/**
 * File `approval · savoir`, séparée de la liste principale et « silencieuse,
 * non comptée » (Inbox.dc.html) : ces propositions n'interrompent jamais une
 * boucle. Repli dashed distinct du liseré plein des items ordinaires. Comme
 * aucun producteur de ce sous-type n'existe dans cette phase (plan Phase 3),
 * `items` est toujours vide en usage réel — ce composant documente
 * l'emplacement où la conscience collective viendra brancher sa file.
 */
export function SavoirGroup({ items, selectedId, onPickItem, projectName }: SavoirGroupProps) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null

  return (
    <div style={{ marginTop: 16 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '6px 2px',
        }}
      >
        <span
          style={{
            font: '600 10px var(--font-mono)',
            letterSpacing: '0.12em',
            color: 'var(--sem-approval)',
          }}
        >
          VALIDATION · SAVOIR
        </span>
        <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
          {items.length === 1
            ? '1 proposition · silencieuse, non comptée'
            : `${items.length} propositions · silencieuses, non comptées`}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            color: 'var(--text-low)',
            transform: `rotate(${open ? '0deg' : '-90deg'})`,
            transition: 'transform var(--dur-2) var(--ease)',
          }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div>
          {items.map((sv) => (
            <SavoirRow
              key={sv.id}
              item={sv}
              selected={selectedId === sv.id}
              onPick={() => onPickItem(sv.id)}
              projectName={projectName(sv.project)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SavoirRow({
  item,
  selected,
  onPick,
  projectName,
}: {
  item: InboxItemView
  selected: boolean
  onPick: () => void
  projectName: string
}) {
  const [hover, hoverProps] = useHover()
  return (
    <button
      type="button"
      onClick={onPick}
      {...hoverProps}
      style={{
        width: '100%',
        textAlign: 'left',
        border: 'none',
        borderLeft: '2px dashed color-mix(in oklab, var(--sem-approval) 55%, transparent)',
        borderRadius: 4,
        background: selected
          ? 'color-mix(in oklab, var(--accent) 6%, transparent)'
          : hover
            ? 'rgba(214, 228, 247, 0.045)'
            : 'transparent',
        padding: '11px 15px',
        marginBottom: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        cursor: 'pointer',
        font: 'inherit',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            font: '600 10px var(--font-mono)',
            letterSpacing: '0.12em',
            color: 'var(--sem-approval)',
            opacity: 0.8,
          }}
        >
          SAVOIR
        </span>
        <span
          style={{ marginLeft: 'auto', font: '11px var(--font-mono)', color: 'var(--text-low)' }}
        >
          {formatAge(item.blockedSince)}
        </span>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-hi)', lineHeight: 1.35 }}>
        {item.title}
      </div>
      <div style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
        {projectName} · {item.agent ?? '·'} · {shortId(item.id)}
      </div>
    </button>
  )
}

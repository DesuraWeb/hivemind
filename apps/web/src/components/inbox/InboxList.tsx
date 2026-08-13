import type { InboxType } from '@silithid/shared'
import type { InboxItemView } from '../../lib/inbox-types'
import { ItemCard } from './ItemCard'
import { SavoirGroup } from './SavoirGroup'
import { TypeChips } from './TypeChips'

export interface InboxListProps {
  items: InboxItemView[]
  savoirItems: InboxItemView[]
  counts: Record<'all' | InboxType, number>
  activeType: 'all' | InboxType
  onPickType: (id: 'all' | InboxType) => void
  selectedId: string | null
  vanishing: ReadonlySet<string>
  onPickItem: (id: string) => void
  projectName: (slug: string | null) => string
}

function EmptyState() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        padding: '64px 20px',
        textAlign: 'center',
      }}
    >
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
        <circle cx="15" cy="15" r="13" stroke="var(--ok)" strokeWidth="1.4" />
        <path
          d="M9.5 15.5l3.6 3.6 7.4-8"
          stroke="var(--ok)"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-hi)' }}>Inbox à zéro</span>
      <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
        toutes les boucles tournent · revenez plus tard
      </span>
    </div>
  )
}

export function InboxList({
  items,
  savoirItems,
  counts,
  activeType,
  onPickType,
  selectedId,
  vanishing,
  onPickItem,
  projectName,
}: InboxListProps) {
  return (
    <div
      style={{
        width: 'clamp(360px, 38vw, 470px)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <TypeChips counts={counts} active={activeType} onPick={onPickType} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 2 }}>
        {items.length === 0 && <EmptyState />}
        {items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            projectName={projectName(item.project)}
            selected={selectedId === item.id}
            vanishing={vanishing.has(item.id)}
            onPick={() => onPickItem(item.id)}
          />
        ))}
        <SavoirGroup
          items={savoirItems}
          selectedId={selectedId}
          onPickItem={onPickItem}
          projectName={projectName}
        />
      </div>
    </div>
  )
}

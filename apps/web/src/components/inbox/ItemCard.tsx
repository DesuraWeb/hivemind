import { formatAge } from '../../lib/age'
import type { InboxItemView } from '../../lib/inbox-types'
import { SEM, shortId, tagLabel } from './constants'
import { useHover } from './useHover'

export interface ItemCardProps {
  item: InboxItemView
  projectName: string
  selected: boolean
  vanishing: boolean
  onPick: () => void
}

/**
 * Item de liste sans cadre : liseré sémantique 2px (`borderLeft`) + espacement
 * — jamais de `border` complète (CLAUDE.md : « items sans cadres »). La
 * disparition (résolution) anime `maxHeight`/`opacity`/`marginBottom` vers 0
 * avant le retrait réel, comme Inbox.dc.html (`it.mh`/`it.op`/`it.mb`).
 */
export function ItemCard({ item, projectName, selected, vanishing, onPick }: ItemCardProps) {
  const [hover, hoverProps] = useHover()
  const semColor = SEM[item.type]

  return (
    <div
      style={{
        maxHeight: vanishing ? '0px' : '140px',
        opacity: vanishing ? 0 : 1,
        marginBottom: vanishing ? '0px' : '8px',
        overflow: 'hidden',
        transition:
          'max-height var(--dur-3) var(--ease), opacity var(--dur-3) var(--ease), margin-bottom var(--dur-3) var(--ease)',
      }}
    >
      <button
        type="button"
        onClick={onPick}
        {...hoverProps}
        style={{
          width: '100%',
          textAlign: 'left',
          border: 'none',
          background: selected
            ? 'color-mix(in oklab, var(--accent) 9%, transparent)'
            : hover
              ? 'rgba(214, 228, 247, 0.045)'
              : 'transparent',
          borderLeft: `2px solid ${semColor}`,
          borderRadius: 4,
          padding: '12px 15px',
          marginBottom: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          cursor: 'pointer',
          transition: 'background var(--dur-1) var(--ease)',
          font: 'inherit',
          color: 'inherit',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span
            style={{ font: '600 10px var(--font-mono)', letterSpacing: '0.12em', color: semColor }}
          >
            {tagLabel(item.type, item.sub)}
          </span>
          <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
            {formatAge(item.blockedSince)}
          </span>
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-hi)', lineHeight: 1.35 }}>
          {item.title}
        </div>
        <div style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
          {projectName} · {item.agent ?? '·'} · {shortId(item.id)}
        </div>
      </button>
    </div>
  )
}

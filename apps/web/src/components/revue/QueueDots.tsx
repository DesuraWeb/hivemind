import type { InboxItemView } from '../../lib/inbox-types'
import { SEM } from '../inbox/constants'

/**
 * La file d'attente en pastilles (`Revue du matin.dc.html`, `dots`) : une par
 * item restant, colorée par type, la courante plus grosse et auréolée.
 */
export function QueueDots({ items, index }: { items: InboxItemView[]; index: number }) {
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      aria-label={`${items.length} items restants`}
    >
      {items.map((it, i) => {
        const color = SEM[it.type]
        const size = i === index ? 9 : 6
        return (
          <span
            key={it.id}
            aria-hidden="true"
            style={{
              width: size,
              height: size,
              borderRadius: 999,
              background: color,
              boxShadow:
                i === index ? `0 0 8px color-mix(in oklab, ${color} 55%, transparent)` : 'none',
              transition: 'all var(--dur-2) var(--ease)',
            }}
          />
        )
      })}
    </span>
  )
}

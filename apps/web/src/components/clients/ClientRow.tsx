import type { ClientView } from '../../lib/api'
import { count, initials } from './format'

/**
 * Une ligne de la liste de gauche (`Clients.dc.html`, `sc-for` sur `clients`).
 *
 * Le prototype colore la pastille d'une teinte par client (`c.tint`). La table
 * `clients` n'a pas de colonne de teinte : la pastille reste neutre plutôt que
 * de recevoir une couleur tirée du nom, qui se lirait comme une information.
 */
export function ClientRow({
  client,
  selected,
  onPick,
}: {
  client: ClientView
  selected: boolean
  onPick: (id: string) => void
}) {
  return (
    <button
      type="button"
      className="clients-row"
      onClick={() => onPick(client.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        padding: '11px 12px',
        borderRadius: 'var(--r-md)',
        border: `1px solid ${
          selected ? 'color-mix(in oklab, var(--accent) 45%, transparent)' : 'transparent'
        }`,
        background: selected ? 'color-mix(in oklab, var(--accent) 8%, transparent)' : 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        transition: 'all var(--dur-1) var(--ease)',
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          flexShrink: 0,
          borderRadius: 999,
          background: 'var(--bg-2)',
          border: '1px solid var(--line-strong)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          font: '600 11px var(--font-sans)',
          color: 'var(--text-mid)',
        }}
      >
        {initials(client.name)}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          style={{
            font: '500 13px var(--font-sans)',
            color: 'var(--text-hi)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {client.name}
        </span>
        <span
          style={{
            font: '10.5px var(--font-mono)',
            color: 'var(--text-low)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {count(client.projects.length, 'projet', 'projets')} ·{' '}
          {count(client.knowledge.length, 'réponse', 'réponses')}
        </span>
      </span>
    </button>
  )
}

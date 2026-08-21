import { Link } from '@tanstack/react-router'
import { PanelActions, PanelButton, SectionLabel } from '../PanelKit'
import type { PanelProps } from './types'

/**
 * Le rappel de revue des savoirs.
 *
 * Un `info`, pas une alerte : rien ne va mal, la mémoire a simplement des
 * savoirs que personne n'a confirmés depuis un trimestre. Le panneau ne
 * propose donc aucune décision sur le contenu — il n'y a rien à trancher ici,
 * la revue se fait sur son propre écran, savoir par savoir.
 *
 * Deux gestes, et ils disent exactement ce qu'ils font : aller faire la revue,
 * ou reconnaître le rappel. « Vu » ne fait PAS disparaître le sujet : le
 * rappel revient si la file grandit, et de toute façon au bout d'un mois
 * (`knowledge/revue-notif.ts`).
 */
export function RevuePanel({ item, resolving, onResolve }: PanelProps) {
  const hive = typeof item.payload.hive === 'string' ? item.payload.hive : null
  const aRevoir = typeof item.payload.aRevoir === 'number' ? item.payload.aRevoir : null
  const actifs = typeof item.payload.actifs === 'number' ? item.payload.actifs : null

  return (
    <>
      <div
        style={{
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-md)',
          background: 'var(--bg-1)',
          padding: '13px 15px',
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
        }}
      >
        <span
          style={{
            font: '600 10px var(--font-sans)',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-mid)',
          }}
        >
          Hive
        </span>
        {/* La phrase est calculée à partir des compteurs, jamais rédigée par un
            modèle : c'est la même que celle de l'écran de revue, mot pour mot. */}
        <span style={{ fontSize: 13, color: 'var(--text-hi)', lineHeight: 1.55 }}>
          {hive ?? 'Des savoirs attendent une confirmation.'}
        </span>
        {aRevoir !== null && actifs !== null && (
          <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
            {aRevoir} à revoir · {actifs} actif{actifs > 1 ? 's' : ''} au total
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SectionLabel>Actions</SectionLabel>
        <PanelActions>
          <Link
            to="/revue-savoirs"
            style={{
              padding: '8px 15px',
              borderRadius: 'var(--r-md)',
              border: '1px solid color-mix(in oklab, var(--accent) 50%, transparent)',
              font: '500 12.5px var(--font-sans)',
              whiteSpace: 'nowrap',
            }}
          >
            Faire la revue →
          </Link>
          <PanelButton
            variant="secondary"
            disabled={resolving}
            onClick={() => onResolve({ action: 'vu' })}
          >
            Vu · plus tard
          </PanelButton>
        </PanelActions>
      </div>
    </>
  )
}

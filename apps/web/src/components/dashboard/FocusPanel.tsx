import type { InboxType } from '@silithid/shared'
import { Link } from '@tanstack/react-router'
import type { CSSProperties, ReactNode } from 'react'
import type { ProjectView } from '../../lib/project-types'
import { badgeFor } from './loop'

/** Libellé de l'action primaire selon le type d'item en attente (Dashboard.dc.html, `PRIMARY`). */
const PRIMARY_LABEL: Record<InboxType, string> = {
  question: 'Répondre à la question',
  approval: 'Traiter la validation',
  verdict: 'Examiner le verdict',
  alert: "Traiter l'alerte",
  handoff: 'Traiter la passation',
  info: "Lire l'info",
}

const SHELL: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 11px',
  borderRadius: 'var(--r-md)',
  font: '500 12.5px var(--font-sans)',
  textAlign: 'left',
  transition: 'all var(--dur-1) var(--ease)',
}

function actionStyle(kind: 'primary' | 'ghost' | 'disabled'): CSSProperties {
  if (kind === 'primary') {
    return {
      ...SHELL,
      border: '1px solid transparent',
      background: 'var(--accent)',
      color: 'var(--accent-ink)',
      cursor: 'pointer',
    }
  }
  if (kind === 'ghost') {
    return {
      ...SHELL,
      border: '1px solid var(--line-strong)',
      background: 'rgba(9, 14, 22, 0.45)',
      color: 'var(--text-hi)',
      cursor: 'pointer',
    }
  }
  return {
    ...SHELL,
    border: '1px dashed var(--line)',
    background: 'transparent',
    color: 'var(--text-low)',
    cursor: 'not-allowed',
  }
}

function ActionBody({ label, hint }: { label: string; hint: string }): ReactNode {
  return (
    <>
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </span>
      <span style={{ font: '11px var(--font-mono)', opacity: 0.7 }}>{hint}</span>
    </>
  )
}

/**
 * Panneau de verre du projet focalisé, sous le brief du matin
 * (Dashboard.dc.html, bloc `sc-if focusedName`). Il ne pilote pas la caméra :
 * le focus vit dans le Dashboard, qui appelle `orb.focus(id)` — ce composant
 * n'est que la face visible de cet état, plus le bouton de relâchement.
 *
 * Écarts assumés au prototype, faute de page côté app :
 * - « Suivre le run en direct » est rendu DÉSACTIVÉ (hint « bientôt ») plutôt
 *   que masqué : la page de run n'existe pas et n'est pas prévue tout de
 *   suite. La masquer ferait disparaître sans explication l'action la plus
 *   attendue d'une boucle en cours ; un lien mort mentirait. Comme elle n'est
 *   plus actionnable, elle cède le rôle primaire à l'action d'inbox (le
 *   prototype la rétrogradait en « ghost » précisément parce que le run
 *   prenait le primaire).
 * - « Ouvrir le projet » pointe sur `/projets/{slug}`, route en cours de
 *   construction par ailleurs : lien natif (pas `Link`) tant qu'elle n'est
 *   pas dans l'arbre de routes typé.
 * - « Staging » est un vrai lien externe ici, là où le prototype laisse un
 *   bouton inerte : la flèche ↗ annonce une sortie, et `staging` porte un
 *   hôte réel. Absent quand le projet n'a pas de staging.
 */
export function FocusPanel({
  project,
  onRelease,
}: {
  project: ProjectView
  onRelease: () => void
}) {
  const badge = badgeFor(project.loop)
  const pending = project.pending[0]
  const tint = project.tint ?? 'var(--pause)'

  return (
    <div
      style={{
        borderRadius: 'var(--r-lg)',
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
        WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
        border: '1px solid var(--glass-border)',
        boxShadow: 'var(--shadow-2), inset 0 1px 0 rgba(255, 255, 255, 0.12)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '11px 12px 11px 14px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            flexShrink: 0,
            borderRadius: 999,
            background: tint,
          }}
        />
        <span
          style={{
            font: '600 13.5px var(--font-sans)',
            color: 'var(--text-hi)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {project.name}
        </span>
        <button
          type="button"
          onClick={onRelease}
          title="Relâcher le focus"
          style={{
            marginLeft: 'auto',
            width: 24,
            height: 24,
            flexShrink: 0,
            borderRadius: 'var(--r-sm)',
            border: '1px solid transparent',
            background: 'transparent',
            color: 'var(--text-mid)',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ font: '11px var(--font-mono)', color: 'var(--text-mid)' }}>
          step {project.step[0]}/{project.step[1]} · {badge.label}
        </div>
        {project.synth && (
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--text-mid)',
              lineHeight: 1.5,
              textWrap: 'pretty',
            }}
          >
            {project.synth}
          </div>
        )}
        <div style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
          conso du jour · {project.conso}
        </div>
      </div>

      <div
        style={{
          padding: '10px 12px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          borderTop: '1px solid var(--line)',
        }}
      >
        <div
          style={{
            font: '600 10px var(--font-mono)',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--text-mid)',
            padding: '0 2px 2px',
          }}
        >
          Actions rapides
        </div>

        {project.loop === 'run' && (
          <button
            type="button"
            disabled
            title="Écran de run à venir"
            style={actionStyle('disabled')}
          >
            <ActionBody label="Suivre le run en direct" hint="bientôt" />
          </button>
        )}

        {pending && (
          <Link to="/inbox" style={actionStyle('primary')}>
            <ActionBody
              label={PRIMARY_LABEL[pending.type]}
              hint={pending.n > 1 ? `${pending.n} items` : ''}
            />
          </Link>
        )}

        <a href={`/projets/${project.id}`} style={actionStyle('ghost')}>
          <ActionBody label="Ouvrir le projet" hint="" />
        </a>

        {project.staging && (
          <a
            href={`https://${project.staging}`}
            target="_blank"
            rel="noreferrer"
            style={actionStyle('ghost')}
          >
            <ActionBody label="Staging" hint={`↗ ${project.staging}`} />
          </a>
        )}
      </div>
    </div>
  )
}

import type { InboxType } from '@silithid/shared'
import { Link } from '@tanstack/react-router'
import { memo } from 'react'
import type { ProjectView } from '../../lib/project-types'
import { badgeFor } from '../dashboard/loop'
import { SEM } from '../inbox/constants'

// `components/globe/` = INTÉRIEUR d'un globe (Projets.dc.html), à ne pas
// confondre avec `components/globes/` = le hub système solaire (Globes.dc.html).

/** `Component.LBL` de Projets.dc.html, complété pour les deux types que le pack ne connaît pas. */
const LBL: Record<InboxType, string> = {
  question: 'question',
  approval: 'validation',
  verdict: 'verdict',
  alert: 'alerte',
  handoff: 'passation',
  info: 'info',
}

/** `Component.ACT` de Projets.dc.html, même complément. */
const ACT: Record<InboxType, string> = {
  question: 'Répondre',
  approval: 'Valider',
  verdict: 'Voir le verdict',
  alert: 'Relancer',
  handoff: 'Voir la passation',
  info: 'Voir',
}

export interface ProjectRowProps {
  project: ProjectView
  globeId: string
  hovered: boolean
  focused: boolean
  /** `null` au départ du curseur — la ligne ne sait pas si une autre a pris le relais. */
  onHover: (id: string | null) => void
  onPick: (id: string) => void
}

/**
 * Une ligne de la liste dense (Projets.dc.html, `sc-for list="{{ rows }}"`).
 *
 * `memo` n'est pas un ornement : le pack dimensionne cet écran pour 100+
 * projets et le survol change l'état à chaque déplacement du curseur (liste
 * ET orbe). Sans mémo, chaque survol re-rendrait les 100 lignes ; avec, seules
 * les deux lignes dont `hovered`/`focused` change sont recalculées. C'est ce
 * qui permet de garder le parti « DOM simple + scroll » du prototype plutôt
 * que de virtualiser.
 *
 * Le clic de focus passe par un vrai `<button>` en calque plein cadre plutôt
 * que par un `onClick` sur le conteneur : la ligne reste atteignable au
 * clavier, et les actions rapides (qui sont, elles, des éléments interactifs
 * imbriqués) restent cliquables grâce à `pointerEvents`.
 */
export const ProjectRow = memo(function ProjectRow({
  project,
  globeId,
  hovered,
  focused,
  onHover,
  onPick,
}: ProjectRowProps) {
  const badge = badgeFor(project.loop)
  const [current, total] = project.step
  const stepWidth = total > 0 ? `${Math.round((current / total) * 100)}%` : '0%'
  const tint = project.tint ?? 'var(--pause)'
  const firstPending = project.pending[0]

  return (
    <div
      onMouseEnter={() => onHover(project.id)}
      onMouseLeave={() => onHover(null)}
      style={{
        position: 'relative',
        borderRadius: 'var(--r-md)',
        borderBottom: '1px solid var(--line)',
        background: focused
          ? 'color-mix(in oklab, var(--accent) 8%, transparent)'
          : hovered
            ? 'rgba(214, 228, 247, 0.045)'
            : 'transparent',
        transition: 'background var(--dur-1) var(--ease)',
      }}
    >
      <button
        type="button"
        onClick={() => onPick(project.id)}
        onFocus={() => onHover(project.id)}
        onBlur={() => onHover(null)}
        aria-label={`${focused ? 'Quitter le focus sur' : 'Mettre au point'} ${project.name}`}
        style={{
          position: 'absolute',
          inset: 0,
          margin: 0,
          padding: 0,
          border: 'none',
          background: 'transparent',
          borderRadius: 'var(--r-md)',
          cursor: 'pointer',
        }}
      />

      <div
        style={{
          position: 'relative',
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          padding: '12px 13px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
              font: '500 13.5px var(--font-sans)',
              color: 'var(--text-hi)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {project.name}
          </span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              font: '10.5px var(--font-mono)',
              color: 'var(--text-low)',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: badge.color,
                animation: badge.pulse ? 'chapoPulse 1.8s var(--ease) infinite' : 'none',
              }}
            />
            {badge.label}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              font: '10.5px var(--font-mono)',
              color: 'var(--text-low)',
              whiteSpace: 'nowrap',
            }}
          >
            step {current}/{total}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 18 }}>
          <div
            style={{
              width: 74,
              flexShrink: 0,
              position: 'relative',
              height: 3,
              background: 'rgba(151, 173, 204, 0.12)',
              borderRadius: 999,
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: stepWidth,
                background: tint,
                borderRadius: 999,
                opacity: 0.85,
              }}
            />
          </div>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '3px 8px',
              font: '10.5px var(--font-mono)',
              color: 'var(--text-mid)',
            }}
          >
            {project.pending.map((p) => (
              <span
                key={p.type}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
              >
                <span style={{ width: 5, height: 5, borderRadius: 999, background: SEM[p.type] }} />
                {p.n} {LBL[p.type]}
              </span>
            ))}
            {project.pending.length === 0 && (
              <span style={{ color: 'var(--text-low)' }}>rien en attente</span>
            )}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              font: '10.5px var(--font-mono)',
              color: 'var(--text-low)',
              whiteSpace: 'nowrap',
              opacity: hovered ? 0 : 1,
              transition: 'opacity var(--dur-1) var(--ease)',
            }}
          >
            {project.conso}
          </span>
          {/* La conso s'efface au survol pour laisser la place aux actions rapides
              (Projets.dc.html : `consoOp` / `actOp`), au même endroit de la ligne. */}
          <span
            style={{
              position: 'absolute',
              right: 13,
              display: 'flex',
              gap: 6,
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? 'auto' : 'none',
              transition: 'opacity var(--dur-2) var(--ease)',
            }}
          >
            {firstPending && (
              <Link
                to="/inbox"
                style={{
                  padding: '4px 11px',
                  borderRadius: 'var(--r-full)',
                  border: '1px solid color-mix(in oklab, var(--accent) 45%, transparent)',
                  background: 'color-mix(in oklab, var(--accent) 14%, rgba(9, 14, 22, 0.9))',
                  color: 'var(--text-hi)',
                  font: '500 11px var(--font-sans)',
                }}
              >
                {ACT[firstPending.type]}
              </Link>
            )}
            <Link
              to="/globes/$globeId/$projectId"
              params={{ globeId, projectId: project.id }}
              style={{
                padding: '4px 11px',
                borderRadius: 'var(--r-full)',
                border: '1px solid var(--line-strong)',
                background: 'rgba(9, 14, 22, 0.9)',
                color: 'var(--text-mid)',
                font: '500 11px var(--font-sans)',
              }}
            >
              Ouvrir →
            </Link>
          </span>
        </div>
      </div>
    </div>
  )
})

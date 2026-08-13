import type { ProjectView } from '../../lib/project-types'
import { SEM, tagLabel } from '../inbox/constants'

/**
 * Carte verre suiveuse au survol d'un cluster de l'orbe (Dashboard.dc.html :
 * `hoverRef`). Positionnée en `fixed` par le parent (coordonnées déjà
 * calculées à partir de `onHover(project, x, y)` d'orb.js) ; ce composant ne
 * fait que le rendu, jamais le calcul de position — pour rester rendu pur en
 * React là où le prototype manipule le DOM directement pour la fluidité.
 */
export function HoverCard({
  project,
  left,
  top,
}: {
  project: ProjectView | null
  left: number
  top: number
}) {
  return (
    <div
      style={{
        position: 'fixed',
        left,
        top,
        width: 276,
        pointerEvents: 'none',
        opacity: project ? 1 : 0,
        transition: 'opacity var(--dur-2) var(--ease)',
        zIndex: 30,
      }}
    >
      <div
        style={{
          position: 'relative',
          borderRadius: 'var(--r-lg)',
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
          WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
          border: '1px solid var(--glass-border)',
          boxShadow: 'var(--shadow-2), inset 0 1px 0 rgba(255, 255, 255, 0.14)',
          overflow: 'hidden',
        }}
      >
        {project && (
          <div
            style={{
              position: 'relative',
              padding: '14px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 9,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 999,
                  background: project.tint ?? 'var(--pause)',
                  boxShadow: `0 0 10px ${project.tint ?? 'var(--pause)'}`,
                }}
              />
              <span style={{ fontSize: 14, fontWeight: 600 }}>{project.name}</span>
              {project.client && (
                <span style={{ fontSize: 12, color: 'var(--text-mid)', marginLeft: 'auto' }}>
                  {project.client}
                </span>
              )}
            </div>
            <div style={{ font: '11.5px var(--font-mono)', color: 'var(--text-mid)' }}>
              {project.line}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {project.pending.length > 0 ? (
                project.pending.map((pp) => (
                  <span
                    key={pp.type}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: 'var(--bg-2)',
                      border: '1px solid var(--line)',
                      font: '10.5px var(--font-mono)',
                      color: 'var(--text-mid)',
                    }}
                  >
                    <span
                      style={{ width: 5, height: 5, borderRadius: 999, background: SEM[pp.type] }}
                    />
                    {pp.n} {tagLabel(pp.type).toLowerCase()}
                  </span>
                ))
              ) : (
                <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
                  rien en attente
                </span>
              )}
            </div>
            <div style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
              conso du jour · {project.conso}
            </div>
            {project.synth && (
              <div
                style={{
                  fontSize: 12.5,
                  color: 'var(--text-mid)',
                  lineHeight: 1.5,
                  borderTop: '1px solid var(--line)',
                  paddingTop: 9,
                  textWrap: 'pretty',
                }}
              >
                {project.synth}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

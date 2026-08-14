import type { PipelineNode } from './state'

/**
 * Le pipeline garant → dev → reviewer → juge (`Run en direct.dc.html`, la
 * bande de quatre pastilles sous le header).
 *
 * Géométrie reprise du pack : colonne de 120 px par rôle, pastille de 9 px
 * (14 px et halo pour le rôle actif), trait de 54 px entre deux colonnes
 * remonté de 30 px pour passer à hauteur des pastilles.
 *
 * Le trait qui relie deux rôles s'allume quand celui de gauche a réellement
 * parlé dans ce run — c'est la même preuve que pour l'état « passé » des
 * pastilles, pas une position dans la chaîne.
 */
export function RunPipeline({ nodes }: { nodes: PipelineNode[] }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '18px 26px 6px',
        flexShrink: 0,
      }}
    >
      {nodes.map((node, i) => {
        const isActive = node.status === 'active'
        const isPassed = node.status === 'passed'
        return (
          <div key={node.role} style={{ display: 'flex', alignItems: 'center' }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                width: 120,
              }}
            >
              <span
                style={{
                  width: isActive ? 14 : 9,
                  height: isActive ? 14 : 9,
                  borderRadius: 999,
                  background: isActive
                    ? `radial-gradient(circle at 35% 30%, #FFFFFF, ${node.color} 55%)`
                    : isPassed
                      ? node.color
                      : 'rgba(151, 173, 204, 0.35)',
                  boxShadow: isActive
                    ? `0 0 18px color-mix(in oklab, ${node.color} 55%, transparent)`
                    : 'none',
                  animation: isActive ? 'chapoPulse 1.8s var(--ease) infinite' : 'none',
                  transition: 'all var(--dur-3) var(--ease)',
                }}
              />
              <span
                style={{
                  font: '600 12px var(--font-sans)',
                  color: isActive ? 'var(--text-hi)' : 'var(--text-mid)',
                }}
              >
                {node.label}
              </span>
              <span
                style={{
                  font: '10px var(--font-mono)',
                  color: 'var(--text-low)',
                  minHeight: 13,
                  whiteSpace: 'nowrap',
                }}
              >
                {node.meta}
              </span>
            </div>
            {i < nodes.length - 1 && (
              <span
                style={{
                  width: 54,
                  height: 1,
                  marginTop: -30,
                  background: isPassed
                    ? 'color-mix(in oklab, var(--ok) 40%, transparent)'
                    : 'var(--line-strong)',
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

import { useEffect, useRef } from 'react'
import type { OrbInstance } from '../../vendor/orb'

/**
 * Marqueur ancré sur le cluster survolé, dans l'orbe.
 *
 * C'est la moitié « liste → orbe » du survol bidirectionnel demandé par
 * CLAUDE.md. L'autre moitié est native (`onHover` d'orb.js remonte le cluster
 * pointé), mais l'inverse ne l'est pas : `orb.js` allume son cluster survolé
 * via un uniform interne (`uHoverCluster`) qu'aucune méthode publique
 * n'expose — et le vendor doit rester octet pour octet identique. On se sert
 * donc de `getClusterPositions()` (API publique, px conteneur) pour poser un
 * halo HTML au-dessus du canvas, à la position du cluster.
 *
 * La position est écrite directement dans le style de l'élément à chaque
 * frame : l'orbe tourne en permanence, repasser par `setState` 60 fois par
 * seconde re-rendrait la liste entière. La boucle ne tourne QUE pendant un
 * survol.
 */
export function ClusterHalo({
  orb,
  hoveredId,
  label,
  tint,
}: {
  orb: OrbInstance | null
  hoveredId: string | null
  label: string
  tint: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!orb || !hoveredId) return
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const el = ref.current
      if (!el) return
      const pos = orb.getClusterPositions().find((p) => p.id === hoveredId)
      if (!pos) {
        el.style.opacity = '0'
        return
      }
      el.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -50%)`
      // Cluster passé derrière l'orbe : on l'estompe au lieu de le masquer,
      // pour que le regard suive la rotation plutôt que de perdre la cible.
      el.style.opacity = pos.front ? '1' : '0.3'
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [orb, hoveredId])

  if (!orb || !hoveredId) return null

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        zIndex: 15,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        pointerEvents: 'none',
        opacity: 0,
        transition: 'opacity var(--dur-1) var(--ease)',
        willChange: 'transform',
      }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: 999,
          border: `1px solid color-mix(in oklab, ${tint} 70%, transparent)`,
          boxShadow: `0 0 18px color-mix(in oklab, ${tint} 30%, transparent)`,
        }}
      />
      <span
        style={{
          font: '10.5px var(--font-mono)',
          color: 'var(--text-hi)',
          whiteSpace: 'nowrap',
          textShadow: '0 1px 6px rgba(3, 6, 12, 0.9)',
        }}
      >
        {label}
      </span>
    </div>
  )
}

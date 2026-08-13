import { useEffect, useRef } from 'react'
import type { OrbInstance, OrbOptions, OrbProject } from '../vendor/orb'
import { create as createOrb } from '../vendor/orb'

export interface OrbCanvasProps {
  /** Clusters affichés dans l'orbe : projets (Dashboard) ou globes (Globes). */
  projects: OrbProject[]
  config?: Record<string, unknown>
  onHover?: OrbOptions['onHover']
  onClusterClick?: OrbOptions['onClusterClick']
  onReady?: (orb: OrbInstance) => void
}

/**
 * Enveloppe React d'orb.js (vendor, non modifié). Une seule instance par
 * montage — CLAUDE.md et le plan Phase 3 sont stricts : « une seule orbe par
 * vue, un seul canvas ». La pause hors viewport / onglet caché est déjà
 * intégrée dans `create()` (IntersectionObserver + `visibilitychange`,
 * cf. orb.js) : ce composant n'a rien à y ajouter, seulement à ne pas la
 * casser en recréant l'instance à tort.
 *
 * La scène WebGL n'est reconstruite que quand la liste de clusters change
 * *utilement* (id/tint/nodes) — pas à chaque rendu React. `onHover` /
 * `onClusterClick` / `config` passent par une ref pour la même raison : des
 * gestionnaires recréés à chaque rendu du parent ne doivent pas provoquer un
 * nouveau canvas.
 */
export function OrbCanvas({ projects, config, onHover, onClusterClick, onReady }: OrbCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ config, onHover, onClusterClick, onReady })
  latest.current = { config, onHover, onClusterClick, onReady }

  const key = JSON.stringify(projects.map((p) => [p.id, p.tint, p.nodes ?? null]))

  // `key` résume déjà les champs utiles de `projects` (id/tint/nodes) ; `config`/
  // `onHover`/`onClusterClick`/`onReady` passent par `latest` (ref) exprès — les
  // inclure en dépendance recréerait le canvas WebGL à chaque rendu du parent,
  // contraire à « un seul canvas » (cf. commentaire du composant).
  // biome-ignore lint/correctness/useExhaustiveDependencies: dépendance réduite à `key` par choix, cf. commentaire ci-dessus.
  useEffect(() => {
    const container = containerRef.current
    if (!container || projects.length === 0) return

    const orb = createOrb(container, {
      projects,
      ...(latest.current.config ? { config: latest.current.config } : {}),
      onHover: (p, x, y) => latest.current.onHover?.(p, x, y),
      onClusterClick: (id) => latest.current.onClusterClick?.(id),
    })
    latest.current.onReady?.(orb)

    return () => {
      orb.destroy()
    }
  }, [key])

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
}

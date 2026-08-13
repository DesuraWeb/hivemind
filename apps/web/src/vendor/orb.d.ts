// Déclaration de types pour orb.js (JS vanille du pack DA, non modifié).
// Ne reflète que l'API publique réellement consommée par les écrans Dashboard
// et Globes ; les détails internes du rendu three.js restent non typés côté
// pack.

/** Un cluster de l'orbe : un projet ou un globe, selon la vue. */
export interface OrbProject {
  id: string
  name?: string
  /** Couleur CSS (hex ou `var(--...)`) — résolue en RGB par orb.js via un canvas 2D. */
  tint: string
  /** Poids relatif de taille du cluster. `orb.js` retombe sur 200 si absent. */
  nodes?: number | null
}

export interface OrbClusterPosition {
  id: string
  x: number
  y: number
  front: boolean
}

export interface OrbOptions {
  projects?: OrbProject[]
  config?: Record<string, unknown>
  onHover?: (project: OrbProject | null, x: number, y: number) => void
  onClusterClick?: (id: string | null) => void
  onStateChange?: (state: string) => void
}

export interface OrbInstance {
  focus(id: string | null): void
  getClusterPositions(): OrbClusterPosition[]
  readonly focusedId: string | null
  destroy(): void
}

export declare const ORB_CONFIG: Record<string, unknown>
export declare const ORB_PRESETS: Record<string, unknown>
export declare function create(container: HTMLElement, opts?: OrbOptions): OrbInstance

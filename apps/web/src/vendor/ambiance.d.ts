// Déclaration de types pour ambiance.js (JS vanille du pack DA, non modifié).
// Le module s'auto-monte sur tout élément [data-chapo-ambiance] via un
// MutationObserver ; on ne consomme ici que l'import pour effet de bord,
// mais on type l'API exportée pour un usage manuel éventuel.

export interface AmbianceInstance {
  repaint(): void
  destroy(): void
}

export interface AmbianceOptions {
  config?: Record<string, unknown>
}

export declare const AMBIANCE: Record<string, unknown>
export declare function paint(container: HTMLElement, opts?: AmbianceOptions): AmbianceInstance

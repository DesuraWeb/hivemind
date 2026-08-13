/**
 * Constantes du système solaire (Globes.dc.html, Component.ORBIT) : une
 * orbite par globe, rayons croissants, vitesse décroissante avec la
 * distance. Reprises telles quelles du prototype — ce ne sont pas des
 * moteurs vendor (pas de fichier `.dc.html` à copier), donc portées ici en
 * TS plutôt que vendorisées.
 */
export const ORBIT = {
  SPEED: 0.05, // rad/s sur l'orbite la plus proche
  SPEED_FALLOFF: 0.72, // les orbites lointaines tournent plus lentement (×^rang)
  R0: 0.17, // rayon de la première orbite (fraction du stage)
  R_STEP: 0.115, // écart entre orbites
  SQUASH: 0.86, // aplatissement vertical (perspective)
  CY: 0.47, // centre vertical
  HOVER_SLOW: 0.15, // ralenti au survol
  SIZE_MIN: 150, // px · plus petit globe
  SIZE_MAX: 195, // px · plus gros globe (écart volontairement contenu)
} as const

/**
 * Position normalisée (0..1, racine carrée) de `weight` dans `allWeights` —
 * même normalisation que le prototype (`Component.sizeOf`), factorisée ici
 * car `sizeOf` (taille px) et `particleCountOf` (nœuds de l'orbe) en ont
 * chacun besoin. Un seul globe (min === max) reçoit `1`, même règle que le
 * prototype (`t = hi === lo ? 1 : ...`).
 */
function weightT(weight: number, allWeights: readonly number[]): number {
  const ns = allWeights.map((w) => Math.sqrt(Math.max(0, w)))
  const lo = Math.min(...ns)
  const hi = Math.max(...ns)
  return hi === lo ? 1 : (Math.sqrt(Math.max(0, weight)) - lo) / (hi - lo)
}

/**
 * Taille du globe ∝ √(poids) entre SIZE_MIN et SIZE_MAX, normalisée sur
 * l'ensemble des globes affichés. `weights` : le poids réel utilisé pour
 * chaque globe — ici `projectCount` (cf. GlobeView, aucune mesure de
 * conscience n'existe encore pour dériver un vrai `nodes`, plan Phase 3).
 */
export function sizeOf(weight: number, allWeights: readonly number[]): number {
  const t = weightT(weight, allWeights)
  return Math.round(ORBIT.SIZE_MIN + t * (ORBIT.SIZE_MAX - ORBIT.SIZE_MIN))
}

/**
 * PARTICLE_COUNT de l'orbe d'un globe. Le prototype (Component.GLOBES) passe
 * directement `nodes` (2600/1500/1300) à `ChapoOrb.create` ; notre schéma n'a
 * pas de `nodes` par globe (cf. commentaire de `GlobeView`, repo.ts) et
 * `projectCount` seul (souvent < 10) donnerait un nuage illisible si utilisé
 * tel quel comme nombre de particules. On réutilise donc la même
 * normalisation que `sizeOf`, mais mise à l'échelle sur l'ordre de grandeur
 * du prototype (1300 à 2600 nœuds) plutôt que sur le poids brut.
 */
const ORB_NODES_MIN = 1200
const ORB_NODES_MAX = 2800
export function particleCountOf(weight: number, allWeights: readonly number[]): number {
  const t = weightT(weight, allWeights)
  return Math.round(ORB_NODES_MIN + t * (ORB_NODES_MAX - ORB_NODES_MIN))
}

/**
 * Rang d'orbite : le plus gros globe sur l'orbite EXTÉRIEURE, le plus petit
 * près du soleil (CLAUDE.md). `weights[i]` = poids du globe à l'index `i` de
 * `ids` ; le rang croît avec le poids (0 = orbite la plus proche).
 */
export function orbitRanks(weights: readonly number[]): number[] {
  const order = weights
    .map((w, i) => ({ w, i }))
    .sort((a, b) => a.w - b.w)
    .map((x) => x.i)
  const ranks = new Array<number>(weights.length)
  order.forEach((i, rank) => {
    ranks[i] = rank
  })
  return ranks
}

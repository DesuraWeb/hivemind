import type { OrbProject } from '../../vendor/orb'
import { OrbCanvas } from '../OrbCanvas'

/**
 * Un seul cluster, aux couleurs de l'accent — `orb.js` résout `var(--accent)`
 * lui-même. Constante de module : `OrbCanvas` reconstruit sa scène quand la
 * liste de clusters change, un tableau recréé à chaque rendu lui ferait
 * repartir un contexte WebGL à chaque frappe.
 */
const SEED: OrbProject[] = [{ id: 'seed', name: 'Silithid', tint: 'var(--accent)', nodes: 300 }]

/** Réglages de l'orbe naissante, repris tels quels de `Onboarding.dc.html`. */
const CONFIG = {
  PARTICLE_COUNT: 2200,
  VEIL_RATIO: 0.6,
  CLUSTER_SPREAD: 1.1,
  SHELL_THICKNESS: 0.14,
  PARTICLE_SIZE: 0.055,
  SIZE_MAX: 1.6,
  ALPHA: 0.65,
  TINT_MIX: 0.35,
  ROT_SPEED: 0.1,
  WOBBLE: 0.07,
  JITTER_AMPL: 0.06,
  PARALLAX: 0.03,
  CAMERA_Z: 3.1,
  HOVER_RADIUS_NDC: 0,
}

/** Trois tailles : rien de vérifié, un point sur deux, les deux. */
const SCALES = [0.5, 0.76, 1]
const OPACITIES = [0.55, 0.7, 0.85]

export interface SeedOrbProps {
  /** Nombre de points réellement vérifiés (0 à 2) · pilote la taille de l'orbe. */
  verified: number
  /** Légende sous l'orbe : ce que cette taille veut dire, en toutes lettres. */
  caption: string
}

/**
 * L'orbe qui naît (`Onboarding.dc.html`) : elle grossit à mesure que l'écran
 * a de quoi grossir. Le prototype la fait grandir à chaque étape cochée par
 * l'utilisateur, y compris celles qui ne vérifient rien ; ici elle ne suit que
 * des faits constatés — un runtime qui a répondu, un projet qui existe. La
 * légende dit lequel, pour qu'une orbe à demi grande ne soit pas une devinette.
 */
export function SeedOrb({ verified, caption }: SeedOrbProps) {
  const level = Math.min(Math.max(verified, 0), 2)

  return (
    <>
      <div
        style={{
          position: 'relative',
          width: 'clamp(140px, 26vh, 210px)',
          height: 'clamp(140px, 26vh, 210px)',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transform: `scale(${SCALES[level]})`,
            opacity: OPACITIES[level],
            transition: 'transform 900ms var(--ease-out), opacity 900ms var(--ease)',
          }}
        >
          <OrbCanvas projects={SEED} config={CONFIG} />
        </div>
      </div>
      <div style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>{caption}</div>
    </>
  )
}

import type { StepView } from '../../lib/project-types'

/**
 * Décalages verticaux de la timeline (Projet.dc.html, `Component.OFFSETS`) :
 * les pastilles ne sont pas alignées, elles ondulent. Repris tels quels,
 * appliqués modulo la longueur comme dans le prototype.
 */
export const STEP_OFFSETS = ['14px', '2px', '20px', '7px', '24px', '12px', '17px']

export interface StepTone {
  /** Couleur de l'état (pastille, libellé d'état, liseré de la carte). */
  color: string
  label: string
  dotSize: number
  dotFill: string
  dotGlow: string
  dotAnim: string
  lineBg: string
  nameColor: string
}

/**
 * `stStyle` de Projet.dc.html, étendu.
 *
 * Le pack ne connaît que quatre états de step (done / run / prod à valider /
 * à venir) là où le serveur en rend cinq : `failed` n'a aucun visuel dans le
 * prototype. Plutôt que de le déguiser en « à venir » — un step en échec et
 * un step pas encore joué n'appellent pas le même geste —, il reçoit ici le
 * traitement de `--sem-alert`, calqué sur celui de `prod à valider`. Écart
 * assumé, et signalé dans le rapport.
 *
 * `iteration` n'est renseigné que pour le step en cours (il vient du run
 * courant) : c'est ce qui produit « en cours · itér. 2/4 ».
 */
export function stepTone(step: StepView, iteration: [number, number] | null = null): StepTone {
  const base = {
    dotSize: 7,
    dotAnim: 'none',
    lineBg: 'var(--line)',
    nameColor: 'var(--text-hi)',
  }
  switch (step.status) {
    case 'validated':
      return {
        ...base,
        color: 'var(--ok)',
        label: 'terminé',
        dotSize: 8,
        dotFill: 'var(--ok)',
        dotGlow: 'none',
        lineBg: 'color-mix(in oklab, var(--ok) 45%, transparent)',
      }
    case 'running':
      return {
        ...base,
        color: 'var(--accent)',
        label: iteration ? `en cours · itér. ${iteration[0]}/${iteration[1]}` : 'en cours',
        dotSize: 12,
        dotFill: 'radial-gradient(circle at 35% 30%, #FFFFFF, var(--accent) 55%)',
        dotGlow: '0 0 16px var(--accent-glow)',
        dotAnim: 'chapoPulse 1.8s var(--ease) infinite',
      }
    case 'awaiting_human':
      return {
        ...base,
        color: 'var(--sem-approval)',
        label: 'en attente humain',
        dotSize: 10,
        dotFill: 'var(--sem-approval)',
        dotGlow: '0 0 12px color-mix(in oklab, var(--sem-approval) 35%, transparent)',
      }
    case 'failed':
      return {
        ...base,
        color: 'var(--sem-alert)',
        label: 'échec',
        dotSize: 10,
        dotFill: 'var(--sem-alert)',
        dotGlow: '0 0 12px color-mix(in oklab, var(--sem-alert) 35%, transparent)',
      }
    case 'pending':
      return {
        ...base,
        color: 'var(--text-low)',
        label: 'à venir',
        dotFill: 'rgba(151, 173, 204, 0.45)',
        dotGlow: 'none',
        nameColor: 'var(--text-mid)',
      }
  }
}

/** « 01 », « 07 »… comme `STEPS[].num` du pack. */
export function stepNumber(position: number): string {
  return String(position).padStart(2, '0')
}

/** « 2 341 » — espace insécable fine à la française, jamais de séparateur anglo-saxon. */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('fr-FR')
}

import type { LoopStatus } from '../../lib/project-types'

export interface LoopBadge {
  label: string
  color: string
  pulse: boolean
}

/**
 * Repris de `badgeFor` (data.js), plus `demarrage` et `stop` : ces deux
 * statuts n'existent pas dans l'énum de data.js (le pack DA n'a de visuel ni
 * pour un projet neuf ni pour une boucle arrêtée, cf. `loopFromRunState`,
 * apps/server/src/projects/derive.ts) — badges neutres ajoutés ici plutôt que
 * de forcer un projet neuf sous « pause » et une boucle arrêtée sous « échec ».
 * Un arrêt est une décision, pas une panne : il n'emprunte pas le rouge.
 */
const BADGE: Record<LoopStatus, LoopBadge> = {
  run: { label: 'en cours', color: 'var(--accent)', pulse: true },
  wait: { label: 'en attente humain', color: 'var(--sem-question)', pulse: false },
  fail: { label: 'échec', color: 'var(--sem-alert)', pulse: false },
  done: { label: 'terminé', color: 'var(--ok)', pulse: false },
  pause: { label: 'pause', color: 'var(--pause)', pulse: false },
  demarrage: { label: 'prêt à démarrer', color: 'var(--text-low)', pulse: false },
  stop: { label: 'boucle stoppée', color: 'var(--text-low)', pulse: false },
}

export function badgeFor(loop: LoopStatus): LoopBadge {
  return BADGE[loop]
}

/** Tri des boucles : le travail en cours d'abord, les endormies en queue (Dashboard.dc.html, Component.LOOP_ORDER). */
export const LOOP_ORDER: Record<LoopStatus, number> = {
  run: 0,
  fail: 1,
  wait: 2,
  pause: 3,
  done: 4,
  // Une boucle arrêtée n'attend rien de personne : elle passe après les
  // terminées, avant les projets qui n'ont jamais démarré.
  stop: 5,
  demarrage: 6,
}

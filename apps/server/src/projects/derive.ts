import type { InboxType, RoleKey, RunState } from '@silithid/shared'

/**
 * Statut *projet* agrégé depuis l'état du run courant. Jamais stocké : deux
 * sources de vérité divergeraient au premier crash (plan Phase 3, Task 4).
 */
export type LoopStatus = 'run' | 'wait' | 'fail' | 'done' | 'pause' | 'demarrage' | 'stop'

/**
 * Correspondance états de run → statut projet.
 *
 *   framing, coding, design_wait, reviewing, deploying, judging, verdict
 *                                            → 'run'   (la boucle avance encore ; même partition qu'`ACTIVE_STATES` de domain/run-state.ts)
 *   awaiting_human                          → 'wait'  (bloqué sur une réponse humaine)
 *   paused_budget, paused_human             → 'pause' (bloqué, budget ou décision humaine)
 *   failed                                  → 'fail'
 *   stopped                                 → 'stop'
 *   done                                    → 'done'
 *
 * Un projet SANS AUCUN run (aucun step encore démarré) reçoit 'demarrage'.
 * Le confondre avec 'pause' serait faux pour l'humain qui consulte la liste :
 * une pause est une décision, un projet neuf est une invitation à démarrer.
 * Les deux appellent des gestes opposés (reprendre vs lancer).
 *
 * Les deux pauses partagent 'pause' : à l'échelle d'une ligne de liste, la
 * seule chose qui compte est qu'un geste humain soit attendu pour repartir.
 * La distinction budget/humain reste lisible sur l'écran « Run en direct »,
 * qui rend `state` tel quel — la dupliquer ici forcerait un second visuel de
 * badge pour une nuance que la liste n'a pas à porter.
 *
 * 'stop' en revanche ne partage RIEN avec 'fail' : un arrêt décidé est une
 * décision, un échec est un constat. Les afficher pareil ferait lire « échec »
 * là où Florian a simplement coupé court.
 *
 * Statuts ajoutés après coup, absents de l'énum `badgeFor` de data.js : le
 * pack DA n'a donc pas de visuel pour eux, c'est un manque à combler côté
 * design.
 */
export function loopFromRunState(state: RunState | null): LoopStatus {
  if (state === null) return 'demarrage'
  if (state === 'awaiting_human') return 'wait'
  if (state === 'paused_budget' || state === 'paused_human') return 'pause'
  if (state === 'failed') return 'fail'
  if (state === 'stopped') return 'stop'
  if (state === 'done') return 'done'
  return 'run'
}

/**
 * Rôle qui possède l'étape en cours, d'après les handlers réellement câblés
 * (loop/steps/*.ts) : framing → garant, coding → dev, reviewing → reviewer.
 * judging et verdict ont leurs handlers depuis la Phase 4 ; `role_templates`
 * définit la clé 'judge' pour cette étape du pipeline, donc on l'utilise pour
 * les deux. deploying n'a aucun des 6 rôles qui lui soit propre ; on le
 * rattache à 'dev', dont le code est en cours de déploiement. design_wait n'a aucune règle cette phase (brief : juge visuel
 * hors périmètre) : aucun rôle ne lui est attribué.
 */
const ROLE_BY_ACTIVE_STATE: Partial<Record<RunState, RoleKey>> = {
  framing: 'garant',
  coding: 'dev',
  reviewing: 'reviewer',
  judging: 'judge',
  verdict: 'judge',
  deploying: 'dev',
}

/** Libellé affiché : identique à la clé sauf `judge` → « juge » (français, cf. data.js). */
const ROLE_LABEL: Record<RoleKey, string> = {
  majordome: 'hive',
  garant: 'garant',
  dev: 'dev',
  reviewer: 'reviewer',
  judge: 'juge',
  communicant: 'communicant',
}

function roleForActiveState(state: RunState | null): string | null {
  if (state === null) return null
  const key = ROLE_BY_ACTIVE_STATE[state]
  return key ? ROLE_LABEL[key] : null
}

/**
 * `awaiting_human` et `paused_human` ne sont pas eux-mêmes pilotés par un
 * rôle : on lit `resume_state` (l'étape à laquelle le run reprendra) pour
 * savoir qui a été interrompu. Pour une pause manuelle c'est même l'essentiel
 * de l'information — « tu as mis le dev en pause » se lit, « pause » tout seul
 * ne dit pas ce qui a été interrompu.
 *
 * `paused_budget`, `done`, `failed` et `stopped` n'ont personne « au travail »
 * à afficher : pause budgétaire décidée hors contexte de rôle, états terminaux
 * où plus aucun agent n'avance la boucle. L'historique de qui a échoué reste
 * consultable via `messages` (piste d'audit), pas dans ce résumé de liste.
 */
export function deriveRole(state: RunState | null, resumeState: RunState | null): string | null {
  if (state === null) return null
  if (state === 'awaiting_human' || state === 'paused_human') return roleForActiveState(resumeState)
  if (state === 'paused_budget' || state === 'done' || state === 'failed' || state === 'stopped') {
    return null
  }
  return roleForActiveState(state)
}

function frNumber(n: number, decimals: number): string {
  return n.toFixed(decimals).replace('.', ',')
}

/**
 * « 14,2 k tokens · 2,10 € » — séparateur « · », jamais de tiret cadratin
 * (règle DA stricte, docs/design/CLAUDE.md). Cas 0 token : « 0 token »
 * littéral (pas de division par zéro à afficher, pas d'euro à 0,00 €).
 */
export function formatConso(totalTokens: number, eurPerMtok: number): string {
  if (totalTokens <= 0) return '0 token'
  const kTokens = totalTokens / 1000
  const eur = (totalTokens / 1_000_000) * eurPerMtok
  return `${frNumber(kTokens, 1)} k tokens · ${frNumber(eur, 2)} €`
}

/** Durée écoulée depuis le début du run courant, seulement quand la boucle avance ('run') ; « · » sinon (data.js). */
export function formatDuree(
  loop: LoopStatus,
  startedAt: Date | null,
  now: Date = new Date(),
): string {
  if (loop !== 'run' || !startedAt) return '·'
  const minutes = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

export interface PendingCount {
  type: InboxType
  n: number
}

export interface LineInput {
  step: [number, number]
  loop: LoopStatus
  role: string | null
  iteration: [number, number] | null
  duree: string
  pending: PendingCount[]
}

/**
 * Résumé une ligne (« line » de data.js), calculé — jamais rédigé, contrairement
 * à `synth` qui reste la prose de Hive. Vérifié champ à champ contre les 6
 * lignes d'exemple de data.js dans le rapport de la Task 4 : 5/6 correspondent
 * exactement, la 6e (bastide, « verdict à valider ») est une formulation
 * éditoriale que ce gabarit générique ne cherche pas à reproduire mot pour
 * mot — cf. rapport.
 */
export function buildLine(input: LineInput): string {
  const stepPart = `step ${input.step[0]}/${input.step[1]}`
  switch (input.loop) {
    case 'run': {
      const parts = [stepPart]
      if (input.role) parts.push(input.role)
      if (input.iteration) parts.push(`itér. ${input.iteration[0]}/${input.iteration[1]}`)
      if (input.duree !== '·') parts.push(input.duree)
      return parts.join(' · ')
    }
    case 'fail': {
      const parts = [stepPart, 'échec']
      if (input.iteration) parts.push(`itér. ${input.iteration[0]}/${input.iteration[1]}`)
      return parts.join(' · ')
    }
    case 'wait': {
      const pendingPart = input.pending.map((p) => `${p.n} ${p.type}`).join(' · ')
      return pendingPart
        ? `${stepPart} · en attente humain · ${pendingPart}`
        : `${stepPart} · en attente humain`
    }
    case 'done':
      return `${stepPart} · terminé`
    case 'pause':
      return `${stepPart} · pause`
    // « arrêté », jamais « échec » : la ligne constate une décision, pas une
    // panne. Le run ne repartira pas, mais personne n'a à chercher ce qui a
    // cassé.
    case 'stop':
      return `${stepPart} · arrêté`
    // Un projet neuf : la ligne invite à lancer, elle ne constate pas un arrêt.
    case 'demarrage':
      return `${stepPart} · prêt à démarrer`
  }
}

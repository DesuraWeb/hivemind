import type { RoleKey } from '@silithid/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { type StoredMessage, appendMessage } from './bus'

/**
 * La consigne injectée : ce que Florian dit à un agent pendant que la boucle
 * tourne.
 *
 * ## Pourquoi ça passe par le bus et pas par une colonne
 *
 * Le mécanisme de passation existe déjà (`loop/bus.ts`) et les handlers en
 * dérivent DÉJÀ tout leur contexte : `framing.ts` relit le bus pour trouver le
 * dernier correctif du garant, `coding.ts` pour trouver les retours du
 * reviewer. Une consigne humaine est la même chose — un message adressé à un
 * rôle — et la ranger ailleurs créerait un second canal à lire, à purger et à
 * afficher dans la timeline. Ici elle apparaît dans la piste d'audit sans une
 * ligne de code de plus, exactement là où on veut la retrouver.
 *
 * ## Pourquoi `fromRole: 'system'` et pas `'garant'`
 *
 * `framing.ts::findLatestCorrection` cherche précisément une `correction`
 * garant→dev. Écrire la consigne humaine sous cette identité la ferait passer
 * pour un correctif de verdict, et écraserait le vrai correctif du tour
 * précédent. `'system'` (déjà utilisé par l'orchestrateur pour ses lignes
 * d'audit) plus un marqueur explicite dans `meta` la rend reconnaissable sans
 * ambiguïté.
 *
 * ## QUAND elle est lue — sans enjoliver
 *
 * Les handlers lisent le bus UNE FOIS, au début de leur invocation, avant
 * d'ouvrir la session de l'agent. Une consigne écrite pendant que le dev
 * travaille n'atteint donc PAS la session en cours : elle sera lue au
 * démarrage de la prochaine invocation du handler du rôle visé (tour
 * dev↔reviewer suivant, ou itération suivante). Ce n'est pas une injection
 * temps réel, et rien ici ne prétend le contraire.
 *
 * La combinaison utile est donc : pause, consigne, reprise — la pause arrête
 * le ré-enfilement, la consigne est posée, la reprise relance un handler qui
 * la lira à son démarrage.
 */

/** Marqueur porté par `messages.meta.source`. Distingue la consigne humaine d'un correctif d'agent. */
export const HUMAN_INSTRUCTION_SOURCE = 'human'

/**
 * Rôles auxquels une consigne peut être adressée : ceux dont le handler la
 * relit réellement (`framing.ts`, `coding.ts`). Accepter 'reviewer' ou 'judge'
 * ferait accepter une consigne que personne ne lirait jamais — un silence pire
 * qu'un refus, puisque Florian croirait avoir parlé.
 */
export const INSTRUCTABLE_ROLES = ['garant', 'dev'] as const
export type InstructableRole = (typeof INSTRUCTABLE_ROLES)[number]

export function isInstructableRole(value: string): value is InstructableRole {
  return (INSTRUCTABLE_ROLES as readonly string[]).includes(value)
}

function isHumanInstruction(m: StoredMessage): boolean {
  return (
    m.kind === 'correction' && m.fromRole === 'system' && m.meta.source === HUMAN_INSTRUCTION_SOURCE
  )
}

/** Écrit la consigne dans le bus. Rien d'autre : c'est le handler du rôle visé qui la lira. */
export async function appendHumanInstruction(
  db: Kysely<Database>,
  opts: { runId: string; toRole: InstructableRole; body: string },
): Promise<void> {
  await appendMessage(db, {
    runId: opts.runId,
    fromRole: 'system',
    toRole: opts.toRole,
    kind: 'correction',
    body: opts.body,
    meta: { source: HUMAN_INSTRUCTION_SOURCE },
  })
}

/**
 * Les consignes qu'un rôle n'a pas encore prises en compte.
 *
 * « Pas encore prise en compte » se dérive du bus, jamais d'une colonne
 * « consommée » : une consigne est en attente tant que le rôle visé n'a rien
 * produit APRÈS elle. Dès qu'il a écrit sa passation suivante, il a travaillé
 * en la connaissant — la réinjecter au tour d'après la ferait ré-appliquer
 * indéfiniment, y compris à l'itération suivante où elle n'a plus de sens.
 *
 * Même philosophie que `findLatestCorrection` (`framing.ts`) : le contexte se
 * dérive des passations réellement écrites, pas d'un compteur — un run repris
 * après un crash retrouve exactement le même comportement.
 */
export function findPendingInstructions(messages: StoredMessage[], forRole: RoleKey): string[] {
  let lastOwn = -1
  for (const [i, m] of messages.entries()) {
    if (m.fromRole === forRole) lastOwn = i
  }
  return messages
    .slice(lastOwn + 1)
    .filter((m) => m.toRole === forRole && isHumanInstruction(m))
    .map((m) => m.body)
}

/**
 * Le bloc à coller dans le préambule d'un agent. Rendu vide (aucune ligne)
 * quand il n'y a pas de consigne : le prompt d'un run sans consigne doit
 * rester rigoureusement identique à ce qu'il était avant cette tâche.
 */
export function instructionsBlock(instructions: string[], heading: string): string[] {
  if (instructions.length === 0) return []
  return [
    heading,
    "Consigne écrite par l'humain qui pilote ce run, pendant la boucle. Elle " +
      'prime sur le cadrage ci-dessus en cas de contradiction : applique-la.',
    ...instructions.map((i) => `- ${i}`),
    '',
  ]
}

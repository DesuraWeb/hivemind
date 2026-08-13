/**
 * Le 4ᵉ gate (Phase 4, Task 6, validé par Florian le 13/08) : trois choses
 * SONT la frontière de sécurité de Silithid, parce que le dépôt qu'il modifie
 * peut être le sien.
 *
 * - `apps/server/src/domain/run-state.ts` — la machine à états, donc les
 *   gates eux-mêmes.
 * - `apps/server/src/runtime/tools.ts` — la traduction d'une `ToolPolicy` en
 *   restriction effective (le premier des 3 gates historiques, Phase 2).
 * - la colonne `roles.tools` — les droits accordés à un rôle sur un projet.
 *
 * Le troisième point n'est pas un chemin de fichier, c'est une colonne de
 * base — et c'est justement le piège à ne pas escamoter. Le mécanisme de
 * détection (`selfmod-gate.ts`) compare des CHEMINS DE FICHIERS modifiés
 * dans une PR ; une colonne ne peut pas y figurer telle quelle. Le choix fait
 * ici : la représenter par son SEUL point d'écriture dans le code,
 * `apps/server/src/loop/roles.ts` (`resolveProjectRole`, qui matérialise
 * `role_templates.tools` dans `roles.tools` à la première résolution d'un
 * rôle pour un projet). Protéger ce fichier protège tout changement du COMMENT
 * cette colonne est peuplée — c'est l'équivalent, côté code, de protéger la
 * colonne elle-même, puisqu'aucune route API n'écrit `roles.tools` par
 * ailleurs à ce stade du projet (vérifié par recherche dans `src/api/`). Si
 * une route d'administration des rôles apparaît plus tard, son fichier devra
 * rejoindre cette liste — exactement pour ça qu'elle vit dans un réglage et
 * pas dans une constante figée.
 */
export interface GuardedPathEntry {
  /** Chemin de fichier relatif à la racine du dépôt (comparaison exacte, pas de glob). */
  path: string
  /** Pourquoi ce chemin est sensible — repris tel quel dans l'item d'inbox. */
  reason: string
}

/** Clé de réglage (`settings.key`) portant la liste éditable des chemins surveillés. */
export const GUARDED_PATHS_SETTINGS_KEY = 'security.guarded_paths'

export const DEFAULT_GUARDED_PATHS: GuardedPathEntry[] = [
  {
    path: 'apps/server/src/domain/run-state.ts',
    reason: 'la machine à états : les gates eux-mêmes en dépendent.',
  },
  {
    path: 'apps/server/src/runtime/tools.ts',
    reason: "la traduction d'une ToolPolicy en restriction effective sur un agent.",
  },
  {
    path: 'apps/server/src/loop/roles.ts',
    reason:
      "seul point d'écriture, dans le code, de la colonne roles.tools (droits accordés à un rôle sur un projet).",
  },
]

/** Vérifie la forme d'une valeur lue depuis `settings` avant de lui faire confiance. */
export function isGuardedPathEntry(value: unknown): value is GuardedPathEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { path?: unknown }).path === 'string' &&
    typeof (value as { reason?: unknown }).reason === 'string'
  )
}

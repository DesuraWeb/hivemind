/**
 * Sérialise les opérations git d'un même dépôt.
 *
 * ## Pourquoi ça devient nécessaire maintenant
 *
 * Jusqu'ici une seule boucle avançait à la fois — non par décision, mais
 * parce que personne n'avait choisi la concurrence de pg-boss. Depuis
 * `LOOP_CONCURRENCY` (env.ts), trois runs peuvent avancer en même temps, et
 * deux d'entre eux peuvent porter sur le MÊME projet, donc le même clone.
 *
 * Git ne le supporte pas. Trois collisions réelles, pas hypothétiques :
 *
 * - deux `ensureProjectRepo` simultanés sur un projet jamais cloné voient
 *   tous les deux un dossier absent et lancent deux `git clone` vers le même
 *   chemin ; le second échoue, ou pire, écrit dans un clone à moitié fait ;
 * - `git worktree add` prend un verrou sur le dépôt : deux ajouts concurrents
 *   se soldent par un « Unable to create index.lock » ;
 * - `git worktree prune`, appelé systématiquement avant chaque ajout et après
 *   chaque suppression, retire les enregistrements dont le répertoire a
 *   disparu. Lancé pendant qu'un autre run est en train de créer le sien, il
 *   peut désenregistrer un worktree parfaitement vivant.
 *
 * ## Une file par dépôt, en mémoire
 *
 * Les opérations git durent des secondes, un tour d'agent des minutes : les
 * sérialiser par dépôt ne coûte rien de mesurable, et deux projets différents
 * ne s'attendent jamais.
 *
 * En mémoire et pas en base, alors qu'un verrou consultatif Postgres existe
 * déjà ailleurs (`tests/setup.ts`) : ce que cette file protège est le système
 * de fichiers LOCAL, et `LOOP_CONCURRENCY` se compte par machine. Deux
 * process qui partageraient le même `WORKTREES_ROOT` seraient un problème
 * différent — et un problème que personne n'a.
 */

const files = new Map<string, Promise<unknown>>()

/**
 * Exécute `fn` quand toutes les opérations déjà en attente sur `key` sont
 * terminées.
 *
 * Un échec de `fn` ne bloque pas la file : le maillon suivant est chaîné sur
 * une version neutralisée de la promesse. C'est le piège classique de ce
 * motif — une seule exception non absorbée fige le dépôt pour toute la durée
 * de vie du process.
 */
export function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const precedent = files.get(key) ?? Promise.resolve()
  const resultat = precedent.then(fn, fn)

  // Ce qu'on mémorise n'est PAS `resultat` mais sa version sans rejet : le
  // maillon suivant doit démarrer que celui-ci ait réussi ou échoué.
  const suivant = resultat.then(
    () => undefined,
    () => undefined,
  )
  files.set(key, suivant)

  // La file se vide d'elle-même : sans ça, chaque dépôt jamais retouché
  // garderait une promesse résolue en mémoire pour toujours.
  void suivant.then(() => {
    if (files.get(key) === suivant) files.delete(key)
  })

  return resultat
}

/** Combien de dépôts ont une file en cours. Pour les tests, et pour eux seuls. */
export function reposVerrouilles(): number {
  return files.size
}

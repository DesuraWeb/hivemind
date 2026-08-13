/**
 * Où le code d'un run devient une URL qu'on peut regarder (Phase 5, Task 3).
 *
 * Même forme que `RuntimeAdapter` : le contrat vit ici, les implémentations
 * ailleurs. La raison n'est pas l'élégance, c'est le parc de Florian. Les
 * vieux projets clients sont sur cPanel et OVH, et ils n'auront pas tous la
 * même voie de dépôt — SSH/rsync sur les uns, FTP sur les autres, `git pull`
 * côté serveur ailleurs. Coder une seule de ces voies en dur dans
 * `loop/steps/deploying.ts` reviendrait à décider aujourd'hui, pour tous les
 * projets à venir, quelque chose qui se décide par projet.
 *
 * ## La différence sémantique à ne pas rater
 *
 * L'aperçu local (l'implémentation provisoire depuis la Phase 4) démarre un
 * serveur qu'il faut arrêter. Un staging réel, lui, **reste debout** : c'est
 * tout l'intérêt, Florian doit pouvoir ouvrir l'URL le lendemain. D'où
 * `release()` plutôt que `close()` : « je n'ai plus besoin de tenir cette
 * ressource », pas « démonte le site ». Pour l'aperçu local, release arrête le
 * serveur. Pour un staging réel, release ne fait rien.
 *
 * Confondre les deux, c'est soit fuir un port à chaque run, soit détruire le
 * staging juste après l'avoir déployé.
 */

/** Ce dont un déploiement a besoin. Volontairement pauvre : pas de handle de base, pas de bus. */
export interface DeployContext {
  runId: string
  /** Le worktree du run — ce qui doit se retrouver à l'URL. */
  worktreePath: string
  /** `projects.slug`, pour les cibles qui nomment un sous-domaine ou un répertoire par projet. */
  projectSlug: string
}

export interface DeployOk {
  ok: true
  /** URL réellement servie. C'est elle que le juge visuel capture. */
  url: string
  /**
   * Ce qui a été déployé et par quelle voie, en une phrase, pour la timeline
   * d'audit. Un humain qui relit un run six semaines plus tard doit pouvoir
   * dire d'où venaient les captures.
   */
  description: string
  /**
   * Libère ce que cette cible tenait. **N'annule pas le déploiement** : sur un
   * staging réel, le site reste en ligne après cet appel.
   */
  release(): Promise<void>
}

export interface DeployFailure {
  ok: false
  /** Repris tel quel dans l'évènement `ci_red`, donc lisible par un humain. */
  reason: string
}

export type DeployResult = DeployOk | DeployFailure

export interface DeployTarget {
  /** Nom court de la voie employée (`local-preview`, `rsync`…), tracé dans l'audit. */
  readonly kind: string
  deploy(ctx: DeployContext): Promise<DeployResult>
}

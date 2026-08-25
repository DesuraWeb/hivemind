import type { EtatServeur } from '@silithid/shared'

/**
 * Les types de l'exploitation (Phase 6).
 *
 * Le contrat vit ici, les implémentations ailleurs — même découpage que
 * `deploy/types.ts` et `runtime/types.ts`, et pour la même raison : ce qui
 * exécute réellement sur un serveur doit pouvoir être remplacé par un faux
 * dans un test, sinon rien de tout ça n'est vérifiable sans un vrai serveur à
 * casser.
 */

/** Un serveur tel que la base le connaît. */
export interface Serveur {
  id: string
  nom: string
  hote: string
  utilisateur: string
  port: number
  url: string | null
  etat: EtatServeur
  /** Le compte SSH passe-t-il par `sudo` ? Défaut vrai (migration 0013). */
  sudo: boolean
  etatMesureAt: Date | null
  preuves: PreuveSonde[]
}

/**
 * Ce qu'une preuve peut dire.
 *
 * `inconnu` n'est PAS une valeur de repli commode : c'est la plus importante
 * des trois. Une sonde qui ne sait pas doit le dire, parce que le verdict
 * global traite le doute comme une occupation.
 */
export type VerdictPreuve = 'occupe' | 'vide' | 'inconnu'

export interface PreuveSonde {
  /** Nom court et stable : `http`, `vhosts`, `fichiers`, `bases`, `journaux`. */
  nom: string
  verdict: VerdictPreuve
  /** Ce qui a été constaté, en une phrase lisible. C'est ce que Florian relit. */
  detail: string
}

/**
 * Ce qui sait exécuter sur un serveur.
 *
 * Un seul point d'entrée, volontairement bas niveau : c'est du code SERVEUR
 * qui l'appelle, jamais un agent. Le catalogue borné (`operations.ts`) est la
 * seule chose qu'un agent compose, et c'est le serveur qui la traduit en
 * script avant d'arriver ici.
 */
export interface OpsExecutor {
  /** Nom de la voie employée (`ssh`, `faux`), tracé dans l'audit. */
  kind: string
  executer(
    serveur: Serveur,
    script: string,
  ): Promise<{ code: number; stdout: string; stderr: string }>
}

/** Ce qui sait interroger une URL publique. Séparé de l'exécuteur : ce n'est pas le même canal. */
export type SondeHttp = (url: string) => Promise<{ statut: number } | { erreur: string }>

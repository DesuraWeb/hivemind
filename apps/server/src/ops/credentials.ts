import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import type { SettingsStore } from '../settings/store'

/**
 * Les accès aux serveurs (Phase 6, Task 6).
 *
 * ## Un jeu par serveur, jamais un passe-partout
 *
 * La clé du coffre est dérivée du NOM du serveur : `ops.<nom>.ssh_private_key`.
 * Ce n'est pas une convention de rangement, c'est la portée elle-même. Une clé
 * unique qui ouvrirait tout le parc ferait de la compromission d'un seul
 * serveur la compromission de tous les clients de Florian d'un coup.
 *
 * `serveurs.nom` est `unique` et validé ici avant toute dérivation : un nom
 * contenant un point transformerait `ops.a.b.ssh_private_key` en une clé qui
 * n'appartient plus au serveur qu'on croit.
 *
 * ## Ce que cette fonction ne fait PAS
 *
 * Elle ne rend jamais un accès à un agent. Le seul appelant est l'exécuteur
 * (`ops/executor.ts`), qui est du code serveur. La surface MCP du rôle `ops`
 * n'expose que le catalogue d'opérations, et une opération ne porte pas de
 * credentials : elle porte un nom et des paramètres, et c'est le serveur qui
 * décide sur quelle machine elle part.
 *
 * Le coffre lui-même ne rend jamais de valeur par l'API (`GET /api/vault`
 * n'expose que des noms de clés) : cette garantie-là est déjà testée depuis la
 * Phase 5, et elle couvre ces clés sans rien ajouter.
 */

/** Suffixes des clés du coffre, par serveur. */
export const OPS_SECRET_SUFFIXES = {
  clePrivee: 'ssh_private_key',
} as const

const NOM_VALIDE = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * Dérive la clé de coffre d'un serveur.
 *
 * Lève sur un nom hors forme plutôt que de nettoyer en silence : deux noms
 * différents qui se nettoieraient en la même clé partageraient un accès, et
 * c'est exactement ce que la portée par serveur existe pour empêcher.
 */
export function cleCoffre(nomServeur: string, suffixe: string): string {
  if (!NOM_VALIDE.test(nomServeur)) {
    throw new Error(
      `nom de serveur invalide : « ${nomServeur} » · attendu [a-z0-9-], sans point — un point changerait la portée de la clé de coffre`,
    )
  }
  return `ops.${nomServeur}.${suffixe}`
}

export class AccesServeurManquantError extends Error {
  constructor(
    readonly nomServeur: string,
    readonly cle: string,
  ) {
    super(
      `aucun accès enregistré pour le serveur « ${nomServeur} » · dépose la clé privée dans le coffre sous « ${cle} », elle ne vaudra que pour ce serveur`,
    )
  }
}

export interface AccesServeur {
  clePrivee: string
  /** La portée, écrite : cet accès vaut pour ce serveur et rien d'autre. */
  portee: string
}

/**
 * Lit l'accès d'un serveur. Lève si le coffre ne le porte pas — jamais de
 * repli sur une autre clé, jamais de valeur par défaut.
 */
export async function lireAcces(
  settings: SettingsStore,
  nomServeur: string,
): Promise<AccesServeur> {
  const cle = cleCoffre(nomServeur, OPS_SECRET_SUFFIXES.clePrivee)
  const valeur = await settings.getSecret(cle)
  if (!valeur) throw new AccesServeurManquantError(nomServeur, cle)
  return { clePrivee: valeur, portee: `serveur ${nomServeur}` }
}

/**
 * Inventaire des serveurs et de l'état de leur accès, pour l'écran Réglages.
 *
 * Rend un booléen, jamais la valeur — même règle que `GET /api/vault`. Savoir
 * qu'un accès existe est utile ; le lire ne l'est pour personne.
 */
export async function inventaireAcces(
  db: Kysely<Database>,
  settings: SettingsStore,
): Promise<Array<{ serveur: string; cle: string; depose: boolean; portee: string }>> {
  const serveurs = await db.selectFrom('serveurs').select(['nom']).orderBy('nom').execute()

  return Promise.all(
    serveurs.map(async (s) => {
      const cle = cleCoffre(s.nom, OPS_SECRET_SUFFIXES.clePrivee)
      return {
        serveur: s.nom,
        cle,
        depose: (await settings.getSecret(cle)) !== undefined,
        portee: `serveur ${s.nom}`,
      }
    }),
  )
}

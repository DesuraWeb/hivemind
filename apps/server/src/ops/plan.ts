import { z } from 'zod'
import { NOMS_OPERATIONS, type NomOperation } from './operations'

/**
 * Le contrat de sortie du rôle `ops`.
 *
 * ## Pourquoi une sortie structurée plutôt qu'une surface d'outils
 *
 * Le garant rend son verdict ainsi, le juge son rapport. Ici la raison est
 * plus forte qu'une cohérence de style : une surface d'outils qui exécuterait
 * les opérations une par une rendrait l'agent capable d'agir. Un plan, lui,
 * est du TEXTE — inerte tant que du code serveur ne l'a pas validé contre le
 * catalogue et traduit en commandes.
 *
 * L'impossibilité d'exécuter n'est donc pas une consigne de prompt qu'on
 * pourrait contourner en insistant : il n'y a rien à appeler.
 *
 * ## `nom` est une énumération, pas une chaîne
 *
 * Le schéma zod n'accepte que les noms réellement présents au catalogue. Un
 * plan qui contiendrait `executer_commande` échoue à la VALIDATION du modèle,
 * avant même d'atteindre `valider()` — et le modèle reçoit l'erreur zod, donc
 * il apprend au tour suivant que cette voie n'existe pas.
 */

// Le cast garde le TYPE des noms (`NomOperation`) plutôt que de le dissoudre
// en `string` : un plan validé est directement utilisable comme `Operation[]`,
// sans re-narrowing qui pourrait être oublié quelque part.
const nomOperationSchema = z.enum(NOMS_OPERATIONS as [NomOperation, ...NomOperation[]])

export const operationPlanifieeSchema = z.object({
  nom: nomOperationSchema,
  params: z.record(z.unknown()),
  /**
   * Pourquoi CE projet en a besoin. « Augmenter memory_limit » ne vaut rien ;
   * « l'import catalogue charge 12 000 produits en mémoire » vaut quelque
   * chose. Une opération sans raison propre au projet est une opération qu'on
   * retirera — d'où le minimum de longueur, qui refuse « nécessaire ».
   */
  raison: z.string().min(20),
  /**
   * Ce qui se passe si personne ne l'applique. Aide à trier, et une
   * proposition honnête sur son propre caractère facultatif est une
   * proposition qu'on lit.
   */
  si_rien_ne_change: z.string().min(1),
})
export type OperationPlanifiee = z.infer<typeof operationPlanifieeSchema>

export const propositionHorsCatalogueSchema = z.object({
  nom_propose: z.string().min(1),
  besoin: z.string().min(20),
  commande_envisagee: z.string().min(1),
})

export const opsPlanSchema = z.object({
  /**
   * Ce que l'agent a réellement LU sur le serveur. Séparé des suppositions,
   * même exigence que le juge visuel : un plan qui présente une supposition
   * comme un constat fait prendre une décision sur du vent.
   */
  constate: z.array(z.string().min(1)),
  suppose: z.array(z.string().min(1)),
  /**
   * Les opérations, DANS L'ORDRE d'exécution. L'exécution s'arrête à la
   * première qui échoue : ce qui ne casse rien d'abord, ce qui touche à un
   * service en dernier.
   */
  operations: z.array(operationPlanifieeSchema),
  /**
   * Ce que le catalogue ne couvre pas. Résultat de premier rang, pas un
   * échec : c'est ainsi que le catalogue grandit. Vide dans la plupart des
   * plans, et c'est le bon défaut.
   */
  hors_catalogue: z.array(propositionHorsCatalogueSchema).default([]),
})
export type OpsPlan = z.infer<typeof opsPlanSchema>

import { z } from 'zod'
import {
  NOMS_OPERATIONS,
  type NomOperation,
  type TypeHebergement,
  operationsAutorisees,
} from './operations'

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

/**
 * L'énumération donnée au modèle, restreinte à ce que cet hébergement permet.
 *
 * C'est le filtrage « à la construction de la surface » : un agent à qui on
 * demande dans son prompt de ne pas proposer `installer_paquet` sur un
 * mutualisé le proposera un jour. Une opération absente de l'énumération,
 * jamais.
 */
function enumOperations(type: TypeHebergement) {
  const noms = operationsAutorisees(type)
  return z.enum(noms as unknown as [NomOperation, ...NomOperation[]])
}

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
  /**
   * Les opérations que l'agent estime devoir devenir STANDARD pour cette
   * stack — donc rejoindre la recette, et s'exécuter d'office au prochain
   * déploiement.
   *
   * Distinct de `operations` : celles-ci valent pour ce serveur-ci, celles-là
   * vaudraient pour tous les suivants. C'est une portée différente, donc une
   * décision différente — et la seule qui élargit ce qui s'exécute en champ
   * libre. Elle passe par l'inbox, jamais par l'accumulation automatique.
   *
   * Borné à 2 : au-delà, l'agent ne propose plus une leçon, il réécrit la
   * recette à chaque passage.
   */
  pour_la_recette: z
    .array(
      z.object({
        nom: nomOperationSchema,
        pourquoi: z
          .string()
          .min(20)
          .describe('Pourquoi TOUTE la stack en a besoin, pas seulement ce serveur.'),
      }),
    )
    .max(2)
    .default([]),
})
export type OpsPlan = z.infer<typeof opsPlanSchema>

/**
 * Le schéma du plan, restreint à ce que CET hébergement permet.
 *
 * Seuls deux champs dépendent du type : les opérations, et celles qu'on
 * propose pour la recette. On les redéfinit plutôt que de recopier le schéma
 * entier — une seconde copie divergerait de la première au premier champ
 * ajouté, et c'est le genre de divergence qu'on ne remarque pas avant qu'un
 * agent ne s'en serve.
 *
 * `opsPlanSchema` reste le cas `vps` : c'est ce que le produit faisait avant
 * qu'un second type d'hébergement n'existe.
 */
export function opsPlanSchemaPour(type: TypeHebergement) {
  const nom = enumOperations(type)
  return opsPlanSchema.extend({
    operations: z.array(operationPlanifieeSchema.extend({ nom })),
    pour_la_recette: z
      .array(
        z.object({
          nom,
          pourquoi: z
            .string()
            .min(20)
            .describe('Pourquoi TOUTE la stack en a besoin, pas seulement ce serveur.'),
        }),
      )
      .max(2)
      .default([]),
  })
}

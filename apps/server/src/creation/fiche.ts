import { z } from 'zod'

/**
 * La fiche que Hive remplit pendant la conversation.
 *
 * ## Pourquoi des retouches partielles, et pas un rendu final
 *
 * C'est la pièce qui rend vrai « les écrans se remplissent d'eux-mêmes ».
 * Hive n'attend pas d'avoir tout compris pour parler à l'écran : dès qu'il
 * apprend le nom du projet, il l'émet, et le fragment d'identité se remplit
 * pendant qu'on discute encore du découpage. Une fiche rendue en fin de
 * conversation redonnerait exactement ce qu'on veut tuer — un écran qui ne
 * bouge pas pendant qu'on parle, puis qui se remplit d'un coup.
 *
 * Chaque champ est donc optionnel, à tous les niveaux. Une retouche dit ce
 * qu'on vient d'apprendre, jamais l'état complet du monde.
 *
 * ## Les listes se remplacent, elles ne fusionnent pas
 *
 * `steps`, `roster` et `savoirs` sont remplacés en entier quand ils sont
 * présents. Fusionner élément par élément supposerait une identité stable
 * dans une liste qu'un agent réécrit librement — et produirait le pire cas :
 * un step retiré par Hive qui réapparaît parce que la fusion ne savait pas
 * qu'il fallait l'oublier. Remplacer est prévisible ; l'agent renvoie la
 * liste entière ou n'y touche pas.
 */

export const CERCLES_SEMABLES = ['projet', 'client', 'globe'] as const

const stepSchema = z.object({
  titre: z.string().min(1),
  specs: z.string(),
  /** `true` = full-auto sur l'itération dev ↔ reviewer. La prod reste un gate. */
  auto: z.boolean().optional(),
  iterations: z.number().int().min(1).max(10).optional(),
})

const rosterSchema = z.object({
  key: z.enum(['garant', 'dev', 'reviewer', 'judge', 'communicant']),
  enabled: z.boolean().optional(),
  systemPrompt: z.string().optional(),
})

const savoirSchema = z.object({
  cercle: z.enum(CERCLES_SEMABLES),
  sujet: z.string().min(1),
  contenu: z.string().min(1),
  stack: z.string().optional(),
  domaine: z.enum(['code', 'exploitation']).optional(),
})

/** Une orbe à créer. Absente, c'est qu'on se pose dans une orbe existante. */
const orbeSchema = z.object({
  nom: z.string().min(1),
  couleur: z.string().optional(),
})

const projetSchema = z.object({
  nom: z.string().optional(),
  /** Slug de l'orbe d'accueil, quand elle existe déjà. */
  orbe: z.string().optional(),
  depot: z.string().optional(),
  clientId: z.string().uuid().optional(),
  stack: z.string().optional(),
  staging: z.string().optional(),
  jugeVisuel: z.boolean().optional(),
})

export const retoucheFicheSchema = z.object({
  orbeACreer: orbeSchema.nullable().optional(),
  projet: projetSchema.optional(),
  steps: z.array(stepSchema).optional(),
  roster: z.array(rosterSchema).optional(),
  savoirs: z.array(savoirSchema).optional(),
})

export type RetoucheFiche = z.infer<typeof retoucheFicheSchema>
export type Fiche = RetoucheFiche

/**
 * Applique une retouche. `projet` fusionne champ à champ — apprendre le dépôt
 * ne doit pas effacer le nom appris trois tours plus tôt. Tout le reste se
 * remplace, pour la raison dite en tête de fichier.
 *
 * Une valeur `undefined` dans la retouche ne fait rien ; c'est ce qui permet à
 * Hive de n'émettre que ce qu'il vient d'apprendre. Pour vider un champ, il
 * envoie la chaîne vide.
 */
export function appliquerRetouche(fiche: Fiche, retouche: RetoucheFiche): Fiche {
  const suite: Fiche = { ...fiche }

  if (retouche.orbeACreer !== undefined) suite.orbeACreer = retouche.orbeACreer
  if (retouche.steps !== undefined) suite.steps = retouche.steps
  if (retouche.roster !== undefined) suite.roster = retouche.roster
  if (retouche.savoirs !== undefined) suite.savoirs = retouche.savoirs

  if (retouche.projet !== undefined) {
    const fusion = { ...(fiche.projet ?? {}) }
    for (const [cle, valeur] of Object.entries(retouche.projet)) {
      if (valeur !== undefined) (fusion as Record<string, unknown>)[cle] = valeur
    }
    suite.projet = fusion
  }

  return suite
}

/**
 * Ce qui manque pour créer, dit en clair.
 *
 * On ne complète rien à la place de personne : une fiche à moitié remplie
 * bloque la création au lieu d'être devinée. C'est la même règle que
 * `projectProblems` côté écran — si Hive n'a pas obtenu le dépôt, il doit le
 * redemander, pas inventer `desura/projet`.
 */
export function manquesFiche(fiche: Fiche): string[] {
  const manques: string[] = []
  const p = fiche.projet ?? {}

  if (!p.nom?.trim()) manques.push('le nom du projet')
  if (!p.depot?.trim()) manques.push('le dépôt')
  if (!fiche.orbeACreer && !p.orbe?.trim()) manques.push("l'orbe d'accueil")

  const steps = fiche.steps ?? []
  if (steps.length === 0) manques.push('au moins un step')
  for (const [i, s] of steps.entries()) {
    if (!s.titre.trim()) manques.push(`le titre du step ${String(i + 1).padStart(2, '0')}`)
  }

  return manques
}

/**
 * L'étape de la scène, dérivée de ce que la fiche contient réellement.
 *
 * C'est ce qui remplace les cinq `setTimeout` du script : un fragment se
 * découvre parce qu'il a du contenu, jamais parce qu'une horloge est arrivée
 * au bout. Un écran qui avance sur une minuterie ment dès que l'agent est
 * plus lent ou plus rapide que prévu.
 */
export function etapeFiche(fiche: Fiche): number {
  let etape = 0
  const p = fiche.projet ?? {}
  if (fiche.orbeACreer || p.orbe || p.nom) etape = 1
  if (p.depot || p.stack) etape = 2
  if ((fiche.steps ?? []).length > 0) etape = 3
  if ((fiche.roster ?? []).length > 0 || (fiche.savoirs ?? []).length > 0) etape = 4
  if (manquesFiche(fiche).length === 0) etape = 5
  return etape
}

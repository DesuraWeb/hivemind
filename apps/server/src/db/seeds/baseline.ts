import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Le socle de règles injecté aux agents, et son recouvrement privé.
 *
 * ## Pourquoi deux niveaux
 *
 * Ces règles sont ce qu'un agent doit savoir sans qu'on le lui répète : ce que
 * « fini » veut dire, ce qu'on ne fait jamais sans demander, les conventions
 * par stack. C'est aussi, pour une agence, la partie qui a le plus de valeur
 * et qui n'a rien à faire dans un dépôt public.
 *
 * D'où un défaut **générique** versionné ici, et un recouvrement **privé**
 * ignoré par git. Si le recouvrement existe, il gagne ; sinon le défaut
 * s'applique. Une installation neuve fonctionne donc immédiatement avec des
 * règles raisonnables, et personne n'a besoin de publier les siennes.
 *
 * Le recouvrement vit dans `seeds/prive/` (ignoré par git). Ce n'est pas un
 * secret au sens du coffre — pas de chiffrement, pas de rotation : c'est du
 * savoir métier, qui se lit et s'édite comme un fichier texte.
 */

const ICI = dirname(fileURLToPath(import.meta.url))
const PRIVE = join(ICI, 'prive')

function lirePrive(nom: string): string | undefined {
  const chemin = join(PRIVE, nom)
  if (!existsSync(chemin)) return undefined
  const contenu = readFileSync(chemin, 'utf8').trim()
  // Un fichier vide est une erreur d'édition, pas une intention de vider les
  // règles : on retombe sur le défaut plutôt que de désarmer le socle.
  return contenu.length > 0 ? contenu : undefined
}

/**
 * Défaut générique. Volontairement court et non négociable : ce sont les
 * points sur lesquels un agent se trompe par défaut, pas un manuel de style.
 * Chacun remplace ceci par ses propres règles via le recouvrement privé ou
 * l'écran Réglages.
 */
const BASELINE_GENERIQUE = `## Ce que « fini » veut dire

- Testé sur mobile, pas seulement sur grand écran.
- Le déploiement a été VÉRIFIÉ, pas seulement lancé.
- Une migration sans retour arrière propre n'est pas finie.
- Sur un site public, le SEO de base n'est pas optionnel : title, meta,
  canonical, et redirections 301 si des URLs changent.

## Jamais sans avoir demandé

- Ajouter une dépendance. Chaque bibliothèque est de la maintenance et une
  surface d'attaque : tu proposes et tu justifies, tu n'installes pas.
- Refactorer hors du périmètre du step. Tu le signales pour plus tard.
- Monter une version majeure, quelle qu'elle soit.
- Toucher à la configuration serveur. Jamais.
- Modifier le schéma de base de données si le step ne le demandait pas.
- Réécrire du style global pour régler un problème local.

## Ce que « proprement » veut dire

- Niveau senior, conventions standards, pas de sur-architecture. Le code le
  plus simple qui tient la route gagne.
- Validation côté serveur systématique, aucun secret en dur, jamais de
  try/catch vide qui avale une erreur.
- Tout contournement ou toute dette laissée est SIGNALÉ dans le rapport. La
  dette cachée est ce qui détruit la confiance.`

/** Règles par stack, injectées seulement quand `projects.stack` correspond. */
const STACK_RULES_GENERIQUES: Record<string, string> = {
  wordpress:
    '- Aucun page builder.\n- Thème enfant obligatoire.\n- Aucun plugin ajouté sans accord explicite : chaque plugin est de la maintenance et une faille potentielle.',
  prestashop: '- On ne touche JAMAIS au core. Overrides propres ou module dédié, point.',
  laravel:
    "- Eager loading par défaut : des N+1 partout, ce n'est pas fini.\n- Les tests suivent l'outil déjà en place dans le dépôt : tu le constates, tu ne l'imposes pas.",
}

/**
 * Le socle effectif. Recouvrement privé s'il existe, défaut générique sinon.
 *
 * `RÈGLE MANQUANTE : …` reste le moyen d'écrire une règle qu'on sait
 * incomplète : Hive dit alors qu'il ne sait pas, plutôt que d'inventer une
 * contrainte.
 */
export const DEFAULT_ANSWER_BASELINE = lirePrive('answer-baseline.md') ?? BASELINE_GENERIQUE

export const DEFAULT_STACK_RULES: Record<string, string> = (() => {
  const brut = lirePrive('stack-rules.json')
  if (!brut) return STACK_RULES_GENERIQUES
  try {
    const parse: unknown = JSON.parse(brut)
    if (typeof parse !== 'object' || parse === null || Array.isArray(parse)) {
      return STACK_RULES_GENERIQUES
    }
    const sorti: Record<string, string> = {}
    for (const [cle, valeur] of Object.entries(parse)) {
      if (typeof valeur === 'string') sorti[cle.toLowerCase()] = valeur
    }
    // Un fichier syntaxiquement valide mais vide ne doit pas effacer les
    // règles : c'est presque toujours une erreur d'édition.
    return Object.keys(sorti).length > 0 ? sorti : STACK_RULES_GENERIQUES
  } catch {
    // JSON invalide : on le dit, et on garde le défaut. Échouer au démarrage
    // pour une virgule en trop dans un fichier optionnel serait disproportionné.
    console.warn('[seed] seeds/prive/stack-rules.json illisible · défaut générique appliqué')
    return STACK_RULES_GENERIQUES
  }
})()

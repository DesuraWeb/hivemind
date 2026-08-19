import type { Kysely } from 'kysely'
import type { Database } from '../db/types'

/**
 * Rendre `hive.stack_rules` vivant (Phase 7, Task 6).
 *
 * ## Le problème
 *
 * `hive.stack_rules` est une **mémoire morte** : je l'ai écrite une fois à
 * partir des règles de Florian, et elle n'a jamais bougé depuis. C'est
 * exactement ce que Florian pointait le 14/08 — « le premier déploiement d'un
 * site Astro ne doit pas être le même que le 15ᵉ ».
 *
 * ## Ce que ça change
 *
 * Un savoir archivé dans le cercle `hive` et portant une `stack` rejoint les
 * règles injectées pour cette stack. Le socle de départ
 * (`seeds/prive/stack-rules.json`, ou le défaut générique) reste : le savoir
 * appris **s'y ajoute, il ne l'écrase pas**. Les règles écrites à la main sont
 * des décisions ; ce qui est appris est une observation. Une observation ne
 * révoque pas une décision — elle la complète, et c'est Florian qui arbitre en
 * corrigeant l'une ou l'autre.
 *
 * ## La ligne à ne pas franchir
 *
 * Une règle apprise **informe** un agent, elle ne lui donne **aucun droit**.
 * Le savoir s'accumule tout seul, le pouvoir ne s'élargit que par une décision
 * humaine (arbitrage de Florian, 14/08). Rien ici ne peut introduire un outil,
 * une permission ou une capacité : ce fichier produit du texte injecté dans un
 * prompt, rien d'autre.
 */

/**
 * Savoirs de stack appris, pour la stack d'un projet.
 *
 * Comparaison en minuscules et par inclusion, la même que le socle statique :
 * « Laravel 12 » déclenche les savoirs marqués `laravel`. Un savoir dont la
 * stack ne correspond pas n'est jamais injecté — mêler des contraintes
 * PrestaShop à un projet WordPress ferait payer des tokens pour du hors-sujet,
 * et diluerait ce qui compte.
 */
export async function savoirsDeStack(
  db: Kysely<Database>,
  stack: string | null,
): Promise<string[]> {
  if (!stack) return []

  const lignes = await db
    .selectFrom('savoirs')
    .select(['sujet', 'contenu', 'stack'])
    .where('etat', '=', 'actif')
    .where('cercle', '=', 'hive')
    .where('stack', 'is not', null)
    .orderBy('created_at', 'asc')
    .execute()

  const cible = stack.toLowerCase()
  return lignes
    .filter((l) => l.stack !== null && cible.includes(l.stack.toLowerCase()))
    .map((l) => `- ${l.sujet} · ${l.contenu}`)
}

/**
 * Fusionne le socle écrit à la main et ce qui a été appris.
 *
 * Les deux blocs restent **distincts et étiquetés**. Un agent — et un humain
 * qui relit — doit pouvoir dire d'où vient une contrainte : une règle posée
 * par Florian n'a pas le même poids qu'une observation tirée d'un run, et les
 * confondre empêcherait de corriger la bonne.
 */
export function fusionner(socle: string | null, appris: string[]): string | null {
  if (!socle && appris.length === 0) return null
  if (appris.length === 0) return socle
  const blocAppris = ['## Appris sur cette stack', ...appris].join('\n')
  return socle ? `${socle}\n\n${blocAppris}` : blocAppris
}

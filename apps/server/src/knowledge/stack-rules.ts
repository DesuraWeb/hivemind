import type { DomaineSavoir } from '@silithid/shared'
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
 * Où un savoir de déploiement est vrai.
 *
 * Vient du serveur visé. Les deux champs sont indépendants : on peut connaître
 * le type sans connaître l'hébergeur (un VPS chez soi), et l'inverse n'arrive
 * pas mais ne casserait rien.
 */
export interface ContexteHebergement {
  /** L'hébergeur nommé, normalisé en minuscules : `planethoster`, `o2switch`… */
  hebergeur?: string | null
  /** `vps` ou `mutualise`. */
  type?: string | null
}

/** Comment nommer un couple, pour pouvoir dire qu'on ne le connaît pas. */
export function nommerCouple(stack: string | null, ou?: ContexteHebergement): string {
  const s = stack?.trim() || 'stack inconnue'
  const chez = ou?.hebergeur?.trim()
  const type = ou?.type?.trim()
  if (chez) return `${s} chez ${chez}`
  if (type) return `${s} sur ${type}`
  return s
}

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
  /**
   * À qui ces savoirs s'adressent (migration 0012). `code` par défaut : c'est
   * ce que cette fonction rendait avant que l'exploitation n'ait sa propre
   * mémoire, et l'appelant historique (`framing.ts`) ne doit pas changer de
   * comportement parce qu'un second destinataire est apparu.
   *
   * Sans ce filtre, le cadrage d'un dev recevrait « poser le robots.txt dès le
   * premier déploiement » et un plan de serveur recevrait « eager loading par
   * défaut ». Ça coûte des tokens pour du hors-sujet, et surtout ça dilue :
   * une contrainte noyée dans dix contraintes étrangères est une contrainte
   * qu'on ne lit plus.
   */
  domaine: DomaineSavoir = 'code',
  /**
   * Où ce savoir sera utilisé. **Absent = seuls les savoirs universels
   * remontent** (`hebergement is null`).
   *
   * C'est délibéré et ça préserve l'appelant historique : le cadrage d'un dev
   * n'a aucun contexte d'hébergement, et une contrainte propre à PlanetHoster
   * n'a rien à y faire. Sans ce défaut strict, ajouter un niveau à la mémoire
   * changerait le prompt d'un rôle qui n'a rien demandé.
   */
  ou?: ContexteHebergement,
): Promise<string[]> {
  if (!stack) return []

  const lignes = await db
    .selectFrom('savoirs')
    .select(['sujet', 'contenu', 'stack', 'hebergement'])
    .where('etat', '=', 'actif')
    .where('cercle', '=', 'hive')
    .where('stack', 'is not', null)
    .where('domaine', '=', domaine)
    .orderBy('created_at', 'asc')
    .execute()

  const cible = stack.toLowerCase()
  const chez = ou?.hebergeur?.trim().toLowerCase() || null
  const type = ou?.type?.trim().toLowerCase() || null

  /**
   * La cascade, du plus précis au plus général — même mécanique que les
   * cercles de mémoire. `null` remonte toujours : un savoir universel reste
   * vrai chez cet hébergeur-là aussi.
   */
  function precision(niveau: string | null): 0 | 1 | 2 | null {
    if (niveau === null) return 0
    const n = niveau.trim().toLowerCase()
    if (chez && n === chez) return 2
    if (type && n === type) return 1
    // Un savoir portant un AUTRE hébergement : écarté, pas rétrogradé. C'est
    // tout l'intérêt du niveau — « Astro chez PlanetHoster » ne doit jamais
    // remonter pour un déploiement sur VPS.
    return null
  }

  return (
    lignes
      .filter((l) => l.stack !== null && cible.includes(l.stack.toLowerCase()))
      .map((l) => ({ l, p: precision(l.hebergement) }))
      .filter((x): x is { l: (typeof lignes)[number]; p: 0 | 1 | 2 } => x.p !== null)
      // Le plus précis en tête : un agent qui lit une liste pondère le haut.
      .sort((a, b) => b.p - a.p)
      .map(({ l, p }) => {
        // La portée est dite sur la ligne. Un agent doit pouvoir juger à quel
        // point un rappel le concerne — et un humain qui relit, savoir lequel
        // corriger.
        const portee =
          p === 2 ? `(chez ${l.hebergement}) ` : p === 1 ? `(sur ${l.hebergement}) ` : ''
        return `- ${portee}${l.sujet} · ${l.contenu}`
      })
  )
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

import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { type ContexteHebergement, nommerCouple, savoirsDeStack } from '../knowledge/stack-rules'
import { estAuCatalogue } from './operations'

/**
 * Les recettes de déploiement par stack (Phase 6, Task 7).
 *
 * Arbitrage de Florian, 14/08 : « le premier déploiement d'un site Astro ne
 * doit pas être le même que le 15ᵉ, parce qu'il aura appris de ses erreurs,
 * des bonnes pratiques, saura appliquer tel ou tel SEO directement ».
 *
 * Même forme que `hive.stack_rules` : un réglage en base, indexé par
 * sous-chaîne de `projects.stack`, modifiable sans redéploiement. Ce n'est pas
 * une coïncidence de style — c'est le mécanisme qui a déjà fait ses preuves
 * pour « on ne touche jamais au core PrestaShop », et le décliner coûte moins
 * qu'en inventer un second.
 *
 * ## LA LIGNE À NE PAS FRANCHIR
 *
 * **Le savoir s'accumule tout seul, le pouvoir ne s'élargit que par une
 * décision humaine.**
 *
 * - Une recette qui s'enrichit d'elle-même : c'est le but.
 * - Un CATALOGUE D'OPÉRATIONS qui s'élargirait de lui-même : c'est un système
 *   qui s'accorde des droits, exactement ce que le 4ᵉ gate rend impossible
 *   pour `run-state.ts` et `tools.ts`.
 *
 * Une recette ne peut donc **jamais** introduire une opération absente du
 * catalogue. Elle COMPOSE des opérations existantes, elle n'en crée pas. Et
 * elle est vérifiée au CHARGEMENT (`chargerRecettes`), pas à l'exécution : une
 * recette invalide doit être refusée bruyamment, jamais ignorée en silence —
 * une étape qui disparaît sans bruit d'une recette de déploiement, c'est un
 * site livré sans son `robots.txt` et personne pour s'en apercevoir.
 *
 * ## Une recette a deux moitiés, et elles n'apprennent PAS pareil
 *
 * - Les **rappels** sont du texte. Ils informent, ils ne donnent aucun droit.
 *   Ils s'accumulent donc tout seuls, depuis les savoirs validés du domaine
 *   `exploitation` (`ops/apprendre.ts`) — et ils ne sont pas STOCKÉS dans la
 *   recette : ils sont lus à chaque fois depuis `savoirs`. Recopier une source
 *   de vérité, c'est en créer une seconde qui divergera au premier crash. Même
 *   raisonnement que `journal/repo.ts`, qui ne stocke rien non plus.
 * - Les **étapes** sont des opérations. Elles s'exécutent, en champ libre, sur
 *   le prochain serveur vierge. Une étape qui s'ajouterait toute seule serait
 *   du pouvoir qui s'élargit sans décision humaine, et c'est exactement la
 *   ligne. Elle passe donc par une proposition validée en inbox.
 */

export const STACK_RECIPES_SETTINGS_KEY = 'ops.stack_recipes'

export interface EtapeRecette {
  /** Nom d'une opération du CATALOGUE. Aucune autre valeur n'est acceptée. */
  operation: string
  /** Paramètres, éventuellement à trous — l'agent les complète pour le projet. */
  params?: Record<string, unknown>
  /** Pourquoi cette étape existe. C'est ce qu'on relit dans six mois. */
  pourquoi: string
}

export interface Recette {
  /** Ce qu'on a appris à faire pour cette stack, en une phrase. */
  resume: string
  etapes: EtapeRecette[]
  /**
   * Ce qu'on oublie toujours. Du texte injecté dans le prompt, pas des
   * opérations : certaines choses se rappellent sans s'automatiser.
   */
  rappels: string[]
}

export class RecetteInvalideError extends Error {
  constructor(stack: string, raison: string) {
    super(`recette « ${stack} » refusée : ${raison}`)
  }
}

/**
 * Le socle générique. Volontairement maigre : ce qui est écrit ici est ce
 * qu'on sait AUJOURD'HUI, et le reste doit venir de l'expérience plutôt que
 * d'une supposition écrite une fois pour toutes.
 *
 * Le SEO de base y figure parce que c'est une règle dure de Florian : « le SEO
 * de base n'est jamais optionnel · casser des URLs indexées sans redirection
 * est mon pire agacement ». Ce n'est pas une bonne pratique parmi d'autres,
 * c'est une contrainte.
 */
export const RECETTES_GENERIQUES: Record<string, Recette> = {
  astro: {
    resume: 'Site statique généré · servi par nginx, aucun runtime à maintenir.',
    etapes: [
      {
        operation: 'installer_paquet',
        params: { paquet: 'nginx' },
        pourquoi: 'Sert les fichiers générés · aucun processus applicatif à surveiller.',
      },
      {
        operation: 'recharger_service',
        params: { service: 'nginx' },
        pourquoi: 'Prend en compte le vhost sans couper les connexions en cours.',
      },
    ],
    rappels: [
      'robots.txt et sitemap.xml posés dès le premier déploiement · le SEO de base n’est jamais optionnel.',
      'Toute URL qui existait avant doit avoir sa redirection 301 · casser une URL indexée est la faute la plus chère.',
      'Les en-têtes de cache sur les assets hashés · sinon le build ne sert à rien.',
    ],
  },
  prestashop: {
    resume: 'Boutique PHP · le core ne se touche jamais, les overrides oui.',
    etapes: [
      {
        operation: 'installer_paquet',
        params: { paquet: 'php8.2-gd' },
        pourquoi: 'Génération des miniatures produit · sans elle le catalogue s’affiche vide.',
      },
      {
        operation: 'activer_extension_php',
        params: { extension: 'intl' },
        pourquoi: 'Formats de prix et de dates localisés · PrestaShop refuse de démarrer sans.',
      },
    ],
    rappels: [
      'On ne touche JAMAIS au core · overrides propres ou module dédié.',
      'memory_limit se dimensionne sur l’import catalogue, pas sur le trafic.',
    ],
  },
}

/**
 * Charge les recettes depuis les réglages, en refusant tout ce qui référence
 * une opération inconnue.
 *
 * Le refus est PAR RECETTE et non global : une recette WordPress mal écrite ne
 * doit pas priver les projets Astro des leurs. Mais la recette fautive est
 * refusée entière et signalée — jamais amputée de son étape invalide, ce qui
 * la rendrait silencieusement incomplète.
 */
export function chargerRecettes(brut: unknown): {
  recettes: Record<string, Recette>
  refusees: Array<{ stack: string; raison: string }>
} {
  const recettes: Record<string, Recette> = {}
  const refusees: Array<{ stack: string; raison: string }> = []

  if (typeof brut !== 'object' || brut === null || Array.isArray(brut)) {
    return { recettes, refusees }
  }

  for (const [stack, valeur] of Object.entries(brut)) {
    const verdict = validerRecette(valeur)
    if (!verdict.ok) {
      refusees.push({ stack, raison: verdict.raison })
      continue
    }
    recettes[stack.toLowerCase()] = verdict.recette
  }

  return { recettes, refusees }
}

function validerRecette(
  valeur: unknown,
): { ok: true; recette: Recette } | { ok: false; raison: string } {
  if (typeof valeur !== 'object' || valeur === null)
    return { ok: false, raison: 'ce n’est pas un objet' }
  const v = valeur as Partial<Recette>

  if (typeof v.resume !== 'string' || v.resume.length === 0) {
    return { ok: false, raison: 'aucun résumé' }
  }
  if (!Array.isArray(v.etapes)) return { ok: false, raison: 'aucune étape' }

  for (const etape of v.etapes) {
    if (typeof etape !== 'object' || etape === null) {
      return { ok: false, raison: 'une étape n’est pas un objet' }
    }
    const e = etape as Partial<EtapeRecette>
    if (typeof e.operation !== 'string') return { ok: false, raison: 'une étape sans opération' }
    // Le point de tout le fichier. Une recette qui introduirait une opération
    // serait un système qui s'accorde des droits.
    if (!estAuCatalogue(e.operation)) {
      return {
        ok: false,
        raison: `l’opération « ${e.operation} » n’est pas au catalogue · une recette compose des opérations existantes, elle n’en crée pas`,
      }
    }
    if (typeof e.pourquoi !== 'string' || e.pourquoi.length === 0) {
      return { ok: false, raison: `l’étape « ${e.operation} » n’explique pas pourquoi elle existe` }
    }
  }

  return {
    ok: true,
    recette: {
      resume: v.resume,
      etapes: v.etapes as EtapeRecette[],
      rappels: Array.isArray(v.rappels)
        ? v.rappels.filter((r): r is string => typeof r === 'string')
        : [],
    },
  }
}

/**
 * La recette d'un projet, par correspondance de sous-chaîne — la même règle
 * que `stack_rules` : « Astro 5 » déclenche `astro`.
 *
 * Rend `null` quand rien ne correspond, et c'est une réponse à part entière :
 * l'agent dira qu'il ne sait pas, comme `RÈGLE MANQUANTE` le fait pour les
 * règles de stack. Inventer une recette pour une stack inconnue serait pire
 * que de ne rien proposer.
 */
export async function recettePourStack(
  db: Kysely<Database>,
  stack: string | null,
): Promise<{ stack: string; recette: Recette } | null> {
  if (!stack) return null

  const row = await db
    .selectFrom('settings')
    .select('value')
    .where('key', '=', STACK_RECIPES_SETTINGS_KEY)
    .executeTakeFirst()

  const { recettes } = chargerRecettes(row?.value ?? RECETTES_GENERIQUES)
  const cible = stack.toLowerCase()

  for (const [nom, recette] of Object.entries(recettes)) {
    if (cible.includes(nom)) return { stack: nom, recette }
  }
  return null
}

/**
 * Rend la recette en texte, pour le prompt de l'agent.
 *
 * Les rappels sont séparés des étapes et étiquetés : une étape est quelque
 * chose qu'on exécute, un rappel est quelque chose qu'on vérifie. Les
 * confondre ferait croire à l'agent qu'un rappel s'automatise.
 *
 * Le socle écrit à la main et ce qui a été APPRIS restent eux aussi distincts
 * et étiquetés — même règle que `stack-rules.ts::fusionner`, et pour la même
 * raison : un agent, comme un humain qui relit, doit pouvoir dire d'où vient
 * une contrainte. Une règle posée par Florian n'a pas le même poids qu'une
 * observation tirée d'un déploiement, et les confondre empêcherait de corriger
 * la bonne.
 */
export function formaterRecette(stack: string, recette: Recette, appris: string[] = []): string {
  const lignes = [`# Recette pour la stack « ${stack} »`, recette.resume, '', '## Étapes']
  for (const e of recette.etapes) {
    lignes.push(`- ${e.operation} · ${e.pourquoi}`)
  }
  if (recette.rappels.length > 0) {
    lignes.push('', '## Ce qu’on oublie toujours', ...recette.rappels.map((r) => `- ${r}`))
  }
  if (appris.length > 0) {
    lignes.push('', '## Appris sur les déploiements précédents', ...appris)
  }
  return lignes.join('\n')
}

/**
 * La recette complète d'un projet : le socle, plus ce que les déploiements
 * précédents ont appris.
 *
 * C'est la fonction que l'agent d'exploitation utilise. Elle rend un texte, y
 * compris quand aucune recette n'existe : dans ce cas seuls les savoirs appris
 * remontent, et l'agent sait au moins ce qui a déjà cassé — c'est mieux que
 * rien, et bien mieux qu'une recette inventée.
 */
export async function recetteComplete(
  db: Kysely<Database>,
  stack: string | null,
  /** Où l'on déploie. Sans lui, seuls les savoirs universels remontent. */
  ou?: ContexteHebergement,
): Promise<string | null> {
  const trouvee = await recettePourStack(db, stack)
  // Lus à chaque fois, jamais recopiés dans la recette : une seconde source de
  // vérité divergerait de la première au premier crash.
  const appris = await savoirsDeStack(db, stack, 'exploitation', ou)

  // Le vide se dit.
  //
  // Quand aucun des trois niveaux de la cascade ne rend rien, on l'ANNONCE au
  // lieu de laisser l'agent proposer avec un aplomb qu'il n'a pas. Un silence
  // est indistinguable de la confiance : « rien à signaler » et « je n'ai
  // jamais fait ça » mènent au même prompt, et pas au même plan.
  const jamaisFait =
    appris.length === 0 && (ou?.hebergeur || ou?.type)
      ? [
          '',
          '## Ce couple est neuf',
          [
            `Aucun déploiement de ${nommerCouple(stack, ou)} n'a jamais été enregistré.`,
            'Tu n’as pas de mémoire ici : lis ce qui est en place avant de proposer,',
            'annonce à Florian ce que tu vas devoir découvrir, et ne présente aucune',
            'version ni aucun chemin comme acquis.',
          ].join(' '),
        ]
      : []

  if (!trouvee) {
    if (appris.length === 0 && jamaisFait.length === 0) return null
    if (appris.length === 0) {
      return [
        `# Stack « ${stack} » · aucune recette écrite`,
        'Personne n’a encore posé de marche à suivre pour cette stack.',
        ...jamaisFait,
      ].join('\n')
    }
    return [
      `# Stack « ${stack} » · aucune recette écrite`,
      'Personne n’a encore posé de marche à suivre pour cette stack. Ce qui suit vient ' +
        'uniquement des déploiements précédents.',
      '',
      '## Appris sur les déploiements précédents',
      ...appris,
      ...jamaisFait,
    ].join('\n')
  }

  return [formaterRecette(trouvee.stack, trouvee.recette, appris), ...jamaisFait].join('\n')
}

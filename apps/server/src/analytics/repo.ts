import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/types'

/**
 * L'économie du système (`docs/design/Analytics.dc.html`) : ce que la
 * plateforme a coûté, et où.
 *
 * ## Ce qui rend cet écran possible
 *
 * Tout se dérive de `runs.cost_tokens`, additionné à chaque échange par
 * `loop/couts.ts::compterPour`.
 *
 * Ce commentaire a longtemps affirmé que « la donnée était déjà là, personne
 * ne la lisait ». C'était FAUX : l'adaptateur émettait bien le coût, les cinq
 * handlers passaient tous `onEvent: () => {}`, et rien n'écrivait la colonne.
 * Cet écran affichait donc zéro pour toujours, quel que soit le travail
 * fourni — constaté en production sur un run dont le garant avait produit un
 * cadrage complet.
 *
 * ## L'attribution au jour
 *
 * Un run est rattaché à la journée de son `started_at`, pas de son `ended_at`.
 * Un run lancé à 23 h 50 et terminé à 0 h 10 compte pour la veille. C'est
 * arbitraire, mais il faut choisir : rattacher à la fin ferait apparaître le
 * coût d'un long run le jour où il se termine, ce qui est plus trompeur — on
 * lit une barre pour savoir ce qu'on a lancé ce jour-là.
 *
 * ## Ce qu'on ne prétend pas savoir
 *
 * Le coût par ITÉRATION n'est pas récupérable : `runs.cost_tokens` est un
 * cumul sur tout le run, itérations comprises, et rien n'enregistre le détail
 * par tour. L'écran affiche un coût par step, jamais par itération.
 */

export interface DailyPoint {
  /** Jour au format ISO court (`2026-08-13`). */
  day: string
  tokens: number
}

export interface ProjectCost {
  /** Slug du projet, comme partout ailleurs dans l'API. */
  id: string
  name: string
  tint: string | null
  tokens: number
  /** Coût en euros, au taux de `settings['pricing.eur_per_mtok']`. */
  eur: number
  /**
   * Steps validés sur la période. Le pack met en avant un projet qui a coûté
   * sans rien valider (« le seul coût sans valeur du mois ») : c'est ce
   * rapprochement qui rend l'écran utile, pas le total seul.
   */
  stepsDone: number
}

export interface StepCost {
  position: number
  title: string
  tokens: number
  eur: number
}

export interface AnalyticsView {
  days: number
  totalTokens: number
  totalEur: number
  daily: DailyPoint[]
  perProject: ProjectCost[]
}

function eur(tokens: number, eurPerMtok: number): number {
  // Arrondi au centime : un coût affiché à la fraction de centime donnerait une
  // fausse impression de précision sur une estimation.
  return Math.round((tokens / 1_000_000) * eurPerMtok * 100) / 100
}

/**
 * Série quotidienne **sans trou** : chaque jour de la fenêtre a son point,
 * même à zéro. Sinon les barres de l'écran se resserreraient sur les jours
 * actifs et un week-end sans activité disparaîtrait au lieu de se voir.
 */
function emptyDays(days: number, now: Date): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000)
    const key = d.toISOString().slice(0, 10)
    out.set(key, 0)
  }
  return out
}

export async function getAnalytics(
  db: Kysely<Database>,
  eurPerMtok: number,
  days: number,
  now: Date = new Date(),
): Promise<AnalyticsView> {
  const since = new Date(now.getTime() - days * 86_400_000)

  const rows = await db
    .selectFrom('runs')
    .innerJoin('steps', 'steps.id', 'runs.step_id')
    .innerJoin('projects', 'projects.id', 'steps.project_id')
    .select([
      'runs.cost_tokens as costTokens',
      'runs.started_at as startedAt',
      'runs.state as state',
      'projects.slug as slug',
      'projects.name as name',
      'projects.tint as tint',
    ])
    // `Generated<Timestamp>` ne compose pas avec un `Date` littéral dans un
    // `where` typé (même bug de types que `projects-api.test.ts` documente
    // pour `.values()`). Un fragment `sql` contourne le typage sans y toucher.
    .where(sql<boolean>`runs.started_at >= ${since}`)
    .execute()

  const daily = emptyDays(days, now)
  const byProject = new Map<string, ProjectCost>()
  let totalTokens = 0

  for (const row of rows) {
    // `cost_tokens` est un bigint : Kysely le rend en chaîne. Le convertir avec
    // `Number` est sûr ici (une conso réaliste reste très loin de 2^53) mais un
    // `+row.costTokens` silencieux serait illisible à la relecture.
    const tokens = Number(row.costTokens)
    totalTokens += tokens

    // Même contournement qu'ailleurs dans le projet : la colonne se lit en
    // chaîne côté Kysely, malgré son type déclaré.
    const day = new Date(row.startedAt as unknown as string).toISOString().slice(0, 10)
    // Un run plus vieux que la fenêtre ne peut pas arriver ici (filtré en SQL),
    // mais un décalage de fuseau pourrait produire une clé absente : on ignore
    // plutôt que de créer un jour hors fenêtre au milieu de la série.
    if (daily.has(day)) daily.set(day, (daily.get(day) ?? 0) + tokens)

    const existing = byProject.get(row.slug)
    if (existing) {
      existing.tokens += tokens
      if (row.state === 'done') existing.stepsDone += 1
    } else {
      byProject.set(row.slug, {
        id: row.slug,
        name: row.name,
        tint: row.tint,
        tokens,
        eur: 0,
        stepsDone: row.state === 'done' ? 1 : 0,
      })
    }
  }

  const perProject = [...byProject.values()]
    .map((p) => ({ ...p, eur: eur(p.tokens, eurPerMtok) }))
    .sort((a, b) => b.tokens - a.tokens)

  return {
    days,
    totalTokens,
    totalEur: eur(totalTokens, eurPerMtok),
    daily: [...daily.entries()].map(([day, tokens]) => ({ day, tokens })),
    perProject,
  }
}

/** Coût par step d'un projet — le panneau de droite de l'écran. */
export async function getStepCosts(
  db: Kysely<Database>,
  eurPerMtok: number,
  projectSlug: string,
): Promise<StepCost[]> {
  const rows = await db
    .selectFrom('steps')
    .innerJoin('projects', 'projects.id', 'steps.project_id')
    .leftJoin('runs', 'runs.step_id', 'steps.id')
    .select([
      'steps.position as position',
      'steps.title as title',
      // `coalesce` : un step sans aucun run doit apparaître à 0, pas
      // disparaître. Un step jamais lancé est une information.
      sql<string>`coalesce(sum(runs.cost_tokens), 0)`.as('tokens'),
    ])
    .where('projects.slug', '=', projectSlug)
    .groupBy(['steps.position', 'steps.title'])
    .orderBy('steps.position', 'asc')
    .execute()

  return rows.map((row) => {
    const tokens = Number(row.tokens)
    return { position: row.position, title: row.title, tokens, eur: eur(tokens, eurPerMtok) }
  })
}

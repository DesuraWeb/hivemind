import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../db/types'

/**
 * Compter ce qu'une boucle dépense.
 *
 * ## Le trou
 *
 * `runs.cost_tokens` n'était écrit NULLE PART. L'adaptateur émettait bien
 * l'évènement de coût, et les cinq handlers passaient tous
 * `onEvent: () => {}` : il était émis, puis jeté.
 *
 * Le commentaire de tête d'`analytics/repo.ts` affirmait pourtant que « tout
 * se dérive de `runs.cost_tokens`, alimenté à chaque échange par l'adapter
 * [...] la donnée était déjà là, personne ne la lisait ». La donnée n'était
 * pas là. L'écran Analytics affichait donc zéro pour toujours, quel que soit
 * le travail fourni.
 *
 * Constaté en production : un run dont le garant avait produit un cadrage
 * complet affichait 0 token.
 *
 * ## Pourquoi une addition en base et pas un compteur en mémoire
 *
 * Trois boucles avancent en parallèle (`LOOP_CONCURRENCY`), et un même run
 * traverse plusieurs passages du worker, potentiellement à des minutes
 * d'écart. Un compteur en mémoire serait perdu entre deux passages et faux
 * dès qu'il y a de la concurrence.
 *
 * `cost_tokens + N` en SQL est atomique : deux écritures simultanées
 * s'additionnent au lieu de s'écraser.
 *
 * ## Pourquoi c'est ATTENDU et pas lancé en arrière-plan
 *
 * C'est de la comptabilité. Une écriture perdue parce que le processus s'est
 * arrêté juste après donnerait un chiffre faux, et un chiffre faux en
 * comptabilité est pire qu'un chiffre absent — on le croit.
 */
export function compterPour(
  db: Kysely<Database>,
  runId: string,
): (tokens: number) => Promise<void> {
  return async (tokens) => {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    await db
      .updateTable('runs')
      .set({ cost_tokens: sql`cost_tokens + ${tokens}` })
      .where('id', '=', runId)
      .execute()
  }
}

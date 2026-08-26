import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { type StartRunResult, startRun } from './start'

/**
 * Enchaîner les steps d'un projet, quand Florian l'a demandé.
 *
 * ## Où ça vit, et pourquoi pas ailleurs
 *
 * Pas dans `decide()` : c'est une fonction pure sur UN run, et lui faire
 * connaître les steps voisins la rendrait dépendante de la base. Pas dans
 * l'orchestrateur non plus : il applique les effets d'une transition dans une
 * transaction, et créer un run là-dedans mêlerait deux boucles de vie.
 *
 * L'enchaînement est de l'ORCHESTRATION : il regarde un run terminé et décide
 * s'il y a une suite. C'est la même nature que la remise en file d'un job.
 *
 * ## Ce qui l'arrête, et rien de tout ça n'est écrit ici
 *
 * - Un step en régime `gated` lève une approbation en fin de step : le run
 *   n'atteint jamais `done`, donc cette fonction n'est même pas appelée. La
 *   chaîne repart quand Florian a tranché et que le run finit.
 * - Un step qui échoue n'atteint pas `done`. On ne relance jamais après une
 *   panne : il y a quelque chose à regarder.
 * - Plus de step en attente : la chaîne s'arrête parce qu'elle est finie.
 *
 * Autrement dit, l'enchaînement n'ajoute AUCUN pouvoir. Il retire un clic
 * entre deux étapes que Florian aurait faites de toute façon.
 */

export interface Enchainement {
  /** Le step suivant, démarré. */
  suivant: StartRunResult
}

export async function enchainerApres(
  db: Kysely<Database>,
  runId: string,
): Promise<Enchainement | null> {
  const courant = await db
    .selectFrom('runs')
    .innerJoin('steps', 'steps.id', 'runs.step_id')
    .innerJoin('projects', 'projects.id', 'steps.project_id')
    .select([
      'steps.position as position',
      'steps.project_id as projectId',
      'projects.enchainement as enchainement',
    ])
    .where('runs.id', '=', runId)
    .executeTakeFirst()

  if (!courant?.enchainement) return null

  // Le PROCHAIN en position, et seulement s'il attend encore. Un step déjà
  // validé, en cours ou en échec ne se relance pas par effet de bord : la
  // chaîne avance, elle ne repasse jamais derrière.
  const suivant = await db
    .selectFrom('steps')
    .select('id')
    .where('project_id', '=', courant.projectId)
    .where('position', '>', courant.position)
    .where('status', '=', 'pending')
    .orderBy('position')
    .executeTakeFirst()

  if (!suivant) return null

  return { suivant: await startRun(db, suivant.id) }
}

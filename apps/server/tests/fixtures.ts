import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '../src/db/types'

/**
 * Garantit qu'un globe existe, et rend son identifiant.
 *
 * Les fixtures s'appuyaient jusqu'ici sur le globe « Desura » que la migration
 * 0002 créait. La 0006 le retire : une installation neuve démarre sans aucun
 * globe (décision de Florian — le nom d'une agence n'a rien à faire dans le
 * schéma, et l'écran de Création sait poser le premier).
 *
 * Un `selectFrom('globes').executeTakeFirstOrThrow()` dans un test dit en
 * réalité « je veux un globe », pas « je veux CELUI de la migration ». C'est
 * ce que cette fonction exprime, et elle ne dépend plus d'une donnée seedée.
 */
export async function ensureGlobe(db: Kysely<Database>): Promise<{ id: string }> {
  const existant = await db.selectFrom('globes').select('id').executeTakeFirst()
  if (existant) return existant

  return db
    .insertInto('globes')
    .values({ name: 'Globe de test', slug: `globe-test-${randomUUID()}`, position: 0 })
    .returning('id')
    .executeTakeFirstOrThrow()
}

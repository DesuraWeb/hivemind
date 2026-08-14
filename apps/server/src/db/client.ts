import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { databaseUrl, loadEnv } from '../env'
import type { Database } from './types'

/**
 * Un pool de 10 connexions, en test comme en production.
 *
 * J'ai essayé `max: 1` en test, pour contrer un cache d'identifiants de
 * relations par connexion que je soupçonnais après un `drop schema`. C'était
 * une mauvaise idée sur deux plans. L'hypothèse n'a jamais été prouvée — la
 * vraie cause était plusieurs processus vitest concurrents, réglée par le
 * verrou consultatif (`tests/setup.ts`). Et surtout, une seule connexion
 * **casse le worker pg-boss** : `applyEvent` ouvre une transaction qui retient
 * la connexion, et le run reste immobile. Mesuré, pas supposé.
 *
 * Ce que ça a révélé au passage et qui reste à creuser : si une seule
 * connexion suffit à bloquer, c'est qu'un chemin réclame une seconde connexion
 * pendant qu'une transaction est ouverte. Masqué à 10, mais latent sous
 * charge.
 */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 })
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}

let singleton: { pool: pg.Pool; db: Kysely<Database> } | undefined

export function getDb(): Kysely<Database> {
  if (!singleton) {
    const pool = createPool(databaseUrl(loadEnv()))
    singleton = { pool, db: createDb(pool) }
  }
  return singleton.db
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.db.destroy()
    singleton = undefined
  }
}

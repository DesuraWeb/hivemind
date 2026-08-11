import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { databaseUrl, loadEnv } from '../env'
import type { Database } from './types'

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

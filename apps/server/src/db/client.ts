import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { databaseUrl, loadEnv } from '../env'
import type { Database } from './types'

/**
 * `max: 1` en test, 10 sinon.
 *
 * Ce n'est pas une optimisation, c'est une correction. Chaque fichier de test
 * commence par `drop schema public cascade; create schema public;` — et
 * PostgreSQL met en cache les identifiants de relations **par connexion**. La
 * connexion qui exécute le DDL invalide son propre cache ; les autres
 * connexions du pool, ouvertes avant, gardent des plans qui pointent des
 * tables détruites. Le test suivant qui tombe sur l'une d'elles échoue avec
 * `relation "x" does not exist`, alors que la table existe.
 *
 * D'où un symptôme trompeur : intermittent, variable d'une exécution à
 * l'autre, jamais reproductible en lançant le fichier seul (un seul fichier
 * ouvre peu de connexions). Il a été attribué trois fois à des « sessions
 * parallèles qui se marchent dessus » avant qu'on regarde vraiment.
 *
 * Une seule connexion par pool en test : celle qui détruit le schéma est
 * celle qui le relit. Le coût est nul, la suite étant déjà sérialisée par
 * `fileParallelism: false` pour cette même raison de base partagée.
 */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: process.env.NODE_ENV === 'test' ? 1 : 10 })
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

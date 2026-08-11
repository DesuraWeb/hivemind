import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { hashPassword, verifyPassword } from './password'

export interface PublicUser {
  id: string
  login: string
}

export async function createUser(
  db: Kysely<Database>,
  login: string,
  password: string,
): Promise<PublicUser> {
  const row = await db
    .insertInto('users')
    .values({ login, password_hash: await hashPassword(password) })
    .returning(['id', 'login'])
    .executeTakeFirstOrThrow()
  return row
}

export async function findUserById(
  db: Kysely<Database>,
  id: string,
): Promise<PublicUser | undefined> {
  return db.selectFrom('users').select(['id', 'login']).where('id', '=', id).executeTakeFirst()
}

/** Renvoie l'utilisateur si le couple est valide, `undefined` sinon. */
export async function authenticate(
  db: Kysely<Database>,
  login: string,
  password: string,
): Promise<PublicUser | undefined> {
  const row = await db
    .selectFrom('users')
    .select(['id', 'login', 'password_hash'])
    .where('login', '=', login)
    .executeTakeFirst()

  if (!row) {
    // Consommer le même temps CPU que pour un utilisateur existant.
    await hashPassword(password)
    return undefined
  }
  if (!(await verifyPassword(row.password_hash, password))) return undefined
  return { id: row.id, login: row.login }
}

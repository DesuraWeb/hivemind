// Crée (ou remplace) l'utilisateur unique de l'outil.
//
//   pnpm --filter @hivemind/server exec tsx scripts/create-user.ts <login> <mot-de-passe>
//
// Le mot de passe est haché en argon2id avant insertion ; il n'est jamais
// stocké ni journalisé en clair.

import { createUser } from '../src/auth/users'
import { closeDb, getDb } from '../src/db/client'

const [login, password] = process.argv.slice(2)

if (!login || !password) {
  console.error('Usage : tsx scripts/create-user.ts <login> <mot-de-passe>')
  process.exit(1)
}

const db = getDb()
// Rejouable : on remplace l'utilisateur existant plutôt que de buter sur la
// contrainte d'unicité de users.login.
await db.deleteFrom('users').where('login', '=', login).execute()
await createUser(db, login, password)
await closeDb()

console.log(`Utilisateur « ${login} » créé.`)

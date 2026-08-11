import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Kysely, sql } from 'kysely'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

/**
 * Applique les migrations `.sql` non encore jouées, par ordre alphabétique.
 * Chaque migration s'exécute dans sa propre transaction : une migration qui
 * échoue laisse les précédentes en place et n'est pas marquée comme appliquée.
 * Un verrou consultatif empêche deux process de migrer en même temps.
 */
export async function runMigrations<DB>(db: Kysely<DB>): Promise<string[]> {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `.execute(db)

  // 4242 : identifiant arbitraire mais stable du verrou de migration.
  await sql`select pg_advisory_lock(4242)`.execute(db)
  try {
    const done = new Set(
      (await sql<{ name: string }>`select name from schema_migrations`.execute(db)).rows.map(
        (r) => r.name,
      ),
    )

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

    const applied: string[] = []
    for (const file of files) {
      if (done.has(file)) continue
      const content = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      await db.transaction().execute(async (trx) => {
        await sql.raw(content).execute(trx)
        await sql`insert into schema_migrations (name) values (${file})`.execute(trx)
      })
      applied.push(file)
    }
    return applied
  } finally {
    await sql`select pg_advisory_unlock(4242)`.execute(db)
  }
}

// Point d'entrée CLI : `pnpm db:migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb, closeDb } = await import('./client')
  const applied = await runMigrations(getDb())
  console.log(
    applied.length ? `Appliquées : ${applied.join(', ')}` : 'Aucune migration à appliquer',
  )
  await closeDb()
}

import pg from 'pg'
import { afterAll, beforeAll } from 'vitest'

/**
 * Sérialise l'accès à la base entre PROCESSUS, pas seulement entre fichiers.
 *
 * ## Le problème, mal diagnostiqué trois fois
 *
 * Chaque fichier de test commence par `drop schema public cascade; create
 * schema public;`. `fileParallelism: false` (vitest.config.ts) sérialise déjà
 * les fichiers **d'un même processus** — mais rien n'empêche deux exécutions
 * de `pnpm test` de tourner en même temps, et c'est le cas courant ici :
 * plusieurs sessions travaillent sur le dépôt, et chacune lance la suite.
 *
 * Le symptôme est trompeur : `relation "x" does not exist` sur des tables qui
 * existent, un nombre d'échecs différent à chaque exécution, et rien de
 * reproductible en lançant le fichier seul. Il a été attribué successivement à
 * « des sessions qui se marchent dessus », à un test nouvellement écrit, puis
 * à un cache de connexions — avant qu'on regarde `pg_stat_activity` et qu'on y
 * trouve cinq processus vitest.
 *
 * ## La solution
 *
 * Un verrou consultatif PostgreSQL, pris avant le premier hook du fichier et
 * relâché après le dernier. Deux suites qui tournent en même temps
 * s'attendent au lieu de se détruire. Le verrou vit sur sa PROPRE connexion,
 * jamais sur celle du pool des tests : une connexion de pool peut être rendue
 * et reprise entre deux requêtes, et le verrou partirait avec elle.
 *
 * Le fichier vit sous `apps/server/tests/` et non à la racine : `pg` est une
 * dépendance du paquet serveur, et pnpm ne la remonte pas à la racine du
 * dépôt — un `setupFiles` racine ne saurait pas la résoudre.
 *
 * Enregistré ici plutôt que dans chacun des quarante fichiers : `setupFiles`
 * s'exécute dans le contexte de chaque fichier, et ses hooks passent avant les
 * `beforeAll` locaux — donc avant le `drop schema`.
 */

/** Identifiant arbitraire mais stable : deux suites doivent choisir le MÊME. */
const LOCK_ID = 8_140_825

let client: pg.Client | undefined

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL
  // Sans URL, il n'y a pas de base à protéger : les tests purs (machine à
  // états, politique d'outils) n'en touchent aucune et ne doivent pas échouer
  // ici.
  if (!connectionString) return

  client = new pg.Client({ connectionString })
  await client.connect()
  // Bloquant, volontairement : on attend son tour plutôt que d'échouer.
  await client.query('select pg_advisory_lock($1)', [LOCK_ID])

  // Purge des jobs pg-boss.
  //
  // `drop schema public cascade` (fait par chaque fichier) NE TOUCHE PAS au
  // schéma `pgboss` : les jobs de toutes les exécutions précédentes s'y
  // accumulent. Mesuré : 847 jobs suffisaient à empêcher le worker d'en
  // consommer un seul, et un run restait immobile en `framing` — panne
  // indiscernable d'un « ça ne fait rien », qui a coûté une heure à
  // diagnostiquer.
  //
  // On vide les jobs plutôt que de détruire le schéma : le recréer à chaque
  // fichier coûterait plusieurs secondes × 50. `to_regclass` évite d'échouer
  // au tout premier passage, quand le schéma n'existe pas encore.
  //
  // Les PLANIFICATIONS aussi, et pour une raison pire : elles ne sont pas
  // consommées, elles FABRIQUENT des jobs toutes les cinq minutes
  // (`budget.probe`) ou tous les quarts d'heure (`auth.healthcheck`), dès
  // qu'un fichier de test a démarré un boss une seule fois. Le job naît
  // ensuite contre un schéma `public` que le fichier suivant vient de
  // détruire, et l'échec tombe sur un test qui n'a rien à voir. Les recréer ne
  // coûte rien : `boss.schedule` est un upsert, `startBoss` les repose.
  await client.query(`
    do $$
    begin
      if to_regclass('pgboss.job') is not null then
        delete from pgboss.job;
      end if;
      if to_regclass('pgboss.schedule') is not null then
        delete from pgboss.schedule;
      end if;
    end $$;
  `)
}, 120_000)

afterAll(async () => {
  if (!client) return
  try {
    // Purge AUSSI à la sortie, avant de rendre le verrou : un fichier ne doit
    // rien laisser derrière lui. Un job `created` oublié est repris par le
    // worker du fichier suivant, contre un schéma `public` déjà détruit — et
    // une planification oubliée en fabrique de nouveaux toute seule.
    await client.query(`
      do $$
      begin
        if to_regclass('pgboss.job') is not null then
          delete from pgboss.job;
        end if;
        if to_regclass('pgboss.schedule') is not null then
          delete from pgboss.schedule;
        end if;
      end $$;
    `)
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID])
  } finally {
    // La déconnexion relâche le verrou de toute façon : un processus tué au
    // milieu ne bloque pas les suivants indéfiniment.
    await client.end()
    client = undefined
  }
})

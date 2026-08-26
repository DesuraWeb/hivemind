import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { runAuthHealthcheck } from '../src/health/auth-check'
import type { Mail, Mailer } from '../src/integrations/mailer'
import { listDecisions } from '../src/journal/repo'
import { createFakeAdapter } from '../src/runtime/fake'
import type { RuntimeAdapter } from '../src/runtime/types'

// `.env` n'est chargé dans process.env que via loadEnv() (voir src/env.ts).
// Passer par databaseUrl() plutôt qu'une URL en dur : sinon un changement de
// configuration ferait tourner les tests contre une autre base sans le dire.
const pool = createPool(databaseUrl(loadEnv()))
const db = createDb(pool)

function fakeMailer(): Mailer {
  const sent: Mail[] = []
  return {
    sent,
    async send(m) {
      sent.push(m)
    },
  }
}

/** Adapter dont le healthcheck échoue : simule un token expiré. */
function brokenAdapter(): RuntimeAdapter {
  return createFakeAdapter({ healthcheckError: 'OAuth token expired' })
}

/** Adapter qui lève au lieu de renvoyer {ok:false} : doit être traité pareil. */
function throwingAdapter(): RuntimeAdapter {
  const base = createFakeAdapter()
  return {
    ...base,
    healthcheck: async () => {
      throw new Error('ECONNREFUSED')
    },
  }
}

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})
beforeEach(async () => {
  await db.deleteFrom('inbox_items').execute()
})
afterAll(async () => {
  await db.destroy()
})

test('runtime sain : ok, aucune alerte, aucun email', async () => {
  const mailer = fakeMailer()
  const result = await runAuthHealthcheck({
    db,
    adapter: createFakeAdapter(),
    mailer,
    alertTo: 'alerts@exemple.test',
  })

  expect(result.ok).toBe(true)
  expect(mailer.sent).toHaveLength(0)
  expect(await db.selectFrom('inbox_items').selectAll().execute()).toHaveLength(0)
})

test('runtime cassé : crée une alerte inbox et envoie un email', async () => {
  const mailer = fakeMailer()
  const result = await runAuthHealthcheck({
    db,
    adapter: brokenAdapter(),
    mailer,
    alertTo: 'alerts@exemple.test',
  })

  expect(result.ok).toBe(false)
  expect(result.error).toContain('OAuth token expired')

  const items = await db.selectFrom('inbox_items').selectAll().execute()
  expect(items).toHaveLength(1)
  expect(items[0]?.type).toBe('alert')
  expect(items[0]?.status).toBe('open')

  expect(mailer.sent).toHaveLength(1)
  expect(mailer.sent[0]?.to).toBe('alerts@exemple.test')
})

test('ne crée pas de doublon tant que l alerte précédente est ouverte', async () => {
  const mailer = fakeMailer()
  const opts = { db, adapter: brokenAdapter(), mailer, alertTo: 'alerts@exemple.test' }

  await runAuthHealthcheck(opts)
  await runAuthHealthcheck(opts)

  expect(await db.selectFrom('inbox_items').selectAll().execute()).toHaveLength(1)
  expect(mailer.sent).toHaveLength(1)
})

test('une alerte résolue ne bloque plus la création d une nouvelle', async () => {
  const mailer = fakeMailer()
  const opts = { db, adapter: brokenAdapter(), mailer, alertTo: 'alerts@exemple.test' }

  await runAuthHealthcheck(opts)
  // L'humain traite l'alerte : la panne suivante doit de nouveau alerter.
  await db.updateTable('inbox_items').set({ status: 'done' }).execute()
  await runAuthHealthcheck(opts)

  expect(await db.selectFrom('inbox_items').selectAll().execute()).toHaveLength(2)
  expect(mailer.sent).toHaveLength(2)
})

test('un adapter qui lève est traité comme une panne, pas comme un succès', async () => {
  const mailer = fakeMailer()
  const result = await runAuthHealthcheck({
    db,
    adapter: throwingAdapter(),
    mailer,
    alertTo: 'alerts@exemple.test',
  })

  expect(result.ok).toBe(false)
  expect(result.error).toContain('ECONNREFUSED')
  expect(await db.selectFrom('inbox_items').selectAll().execute()).toHaveLength(1)
})

test('un runtime qui ne répond jamais est traité comme une panne', async () => {
  const mailer = fakeMailer()
  const hanging: RuntimeAdapter = {
    ...createFakeAdapter(),
    healthcheck: () => new Promise(() => {}), // ne se résout jamais
  }

  const result = await runAuthHealthcheck({
    db,
    adapter: hanging,
    mailer,
    alertTo: 'alerts@exemple.test',
    timeoutMs: 50,
  })

  expect(result.ok).toBe(false)
  expect(result.error).toMatch(/Pas de réponse du runtime/)
  expect(mailer.sent).toHaveLength(1)
})

test('l’authentification revenue ferme l’alerte, au lieu de la laisser mentir', async () => {
  // Elle n'était JAMAIS fermée. Une panne passagère laissait donc une alerte
  // définitive, affichée sur tous les écrans par le bandeau permanent —
  // constaté en production, où elle était restée ouverte alors que
  // l'authentification fonctionnait. Une alerte qui ment est pire qu'une
  // alerte absente : elle apprend à ne plus lire les alertes.
  const mailer = fakeMailer()
  await runAuthHealthcheck({
    db,
    adapter: brokenAdapter(),
    mailer,
    alertTo: 'alerts@exemple.test',
  })
  const ouverte = await db
    .selectFrom('inbox_items')
    .selectAll()
    .where('status', '=', 'open')
    .execute()
  expect(ouverte).toHaveLength(1)

  const apres = await runAuthHealthcheck({
    db,
    adapter: createFakeAdapter(),
    mailer,
    alertTo: 'alerts@exemple.test',
  })
  expect(apres.ok).toBe(true)

  const restantes = await db
    .selectFrom('inbox_items')
    .select(['status', 'human_response'])
    .where('type', '=', 'alert')
    .execute()
  expect(restantes.every((i) => i.status === 'done')).toBe(true)
  // `done` et non `dismissed` : le problème a été RÉSOLU, pas écarté. Et la
  // raison reste lisible dans l'historique.
  expect(JSON.stringify(restantes[0]?.human_response)).toContain('healthcheck')

  // `resolved_at` est ce que le journal lit pour savoir qu'une décision a été
  // prise. Sans lui, l'alerte cesse de mentir mais disparaît en silence : rien
  // ne consigne qu'elle a été résolue, et le journal de la nuit ne la montre
  // jamais. C'est le même travers que celui qu'on venait de corriger, déplacé
  // d'un cran — trouvé en production, pas ici.
  const resolue = await db
    .selectFrom('inbox_items')
    .select('resolved_at')
    .where('type', '=', 'alert')
    .executeTakeFirstOrThrow()
  expect(resolue.resolved_at).not.toBeNull()

  // Le bout de chaîne qui compte vraiment : elle apparaît dans le journal.
  const decisions = await listDecisions(db, { since: new Date(Date.now() - 3_600_000) })
  expect(decisions.some((d) => d.title.includes('Authentification'))).toBe(true)

  // Le retour à la normale ne s'annonce pas par un email : personne ne veut
  // être réveillé pour une bonne nouvelle.
  expect(mailer.sent).toHaveLength(1)
})

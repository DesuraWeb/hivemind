import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { listInbox } from '../src/inbox/repo'
import type { Operation } from '../src/ops/operations'
import { lireServeur } from '../src/ops/probe'
import {
  MAX_ITERATIONS_PROVISION,
  type RapportProvision,
  ServeurNonViergeError,
  criteresDepuisOperations,
  provisionner,
} from '../src/ops/provision'
import type { OpsExecutor } from '../src/ops/types'
import { createFakeAdapter } from '../src/runtime/fake'
import type { RuntimeAdapter } from '../src/runtime/types'

/**
 * Hébergement vierge : champ libre puis jugement (Phase 6, Task 4).
 *
 * Le champ libre n'est acceptable que parce qu'il n'y a rien à casser. Ce
 * fichier vérifie donc surtout ses bornes : il n'existe que sur un serveur
 * MESURÉ vierge, et il se referme définitivement dès qu'il a servi.
 */

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  await db.deleteFrom('inbox_items').execute()
  await db.deleteFrom('serveurs').execute()
})

async function creerServeur(etat: 'inconnu' | 'vierge' | 'en_service'): Promise<string> {
  const row = await db
    .insertInto('serveurs')
    .values({
      nom: `srv-${randomUUID().slice(0, 8)}`,
      hote: '203.0.113.30',
      utilisateur: 'silithid',
      etat,
      ...(etat === 'inconnu' ? {} : { etat_mesure_at: new Date() }),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

function executeur(echouerSi?: (script: string) => boolean): {
  executor: OpsExecutor
  scripts: string[]
} {
  const scripts: string[] = []
  return {
    scripts,
    executor: {
      kind: 'faux',
      executer: async (_s, script) => {
        scripts.push(script)
        return echouerSi?.(script)
          ? { code: 1, stdout: '', stderr: 'No space left on device' }
          : { code: 0, stdout: 'ok', stderr: '' }
      },
    },
  }
}

/** Un adaptateur qui fait rendre au juge les rapports qu'on lui dicte, dans l'ordre. */
function adapterJuge(rapports: RapportProvision[]): RuntimeAdapter {
  const base = createFakeAdapter()
  let i = 0
  return {
    ...base,
    async send(session, message, options) {
      const rapport = rapports[Math.min(i++, rapports.length - 1)]
      const r = await base.send(session, message, options)
      return {
        ...r,
        toolCalls: [{ name: 'submit_rapport_provision', input: rapport }],
      }
    },
  }
}

const OPERATIONS: Operation[] = [
  { nom: 'installer_paquet', params: { paquet: 'nginx' } },
  { nom: 'recharger_service', params: { service: 'nginx' } },
]

function planAvec(rapports: RapportProvision[]) {
  return {
    plan: {
      operations: OPERATIONS,
      criteres: criteresDepuisOperations(OPERATIONS),
      jugeSystemPrompt: '# Juge',
      jugeCwd: '/tmp',
    },
    adapter: adapterJuge(rapports),
  }
}

const CONFORME: RapportProvision = {
  conformites: ['nginx installé (1.24.0)', 'service actif'],
  ecarts: [],
}
const BLOQUANT: RapportProvision = {
  conformites: [],
  ecarts: [{ severite: 'bloquant', constat: 'nginx ne démarre pas', preuve: 'systemctl : failed' }],
}
const MINEUR: RapportProvision = {
  conformites: ['nginx installé'],
  ecarts: [
    { severite: 'mineur', constat: 'version plus ancienne que prévu', preuve: '1.18 vs 1.24' },
  ],
}

// --- Les bornes du champ libre ----------------------------------------------

test('le champ libre n’existe que sur un serveur MESURÉ vierge', async () => {
  const { plan, adapter } = planAvec([CONFORME])
  const espion = executeur()

  for (const etat of ['inconnu', 'en_service'] as const) {
    const id = await creerServeur(etat)
    await expect(
      provisionner({ db, executor: espion.executor, adapter, serveurId: id }, plan),
    ).rejects.toThrow(ServeurNonViergeError)
  }
  // Un serveur jamais mesuré n'a droit à aucune autonomie : rien n'est parti.
  expect(espion.scripts).toHaveLength(0)
})

test('le message de refus dit par où passer à la place', async () => {
  const id = await creerServeur('en_service')
  const { plan, adapter } = planAvec([CONFORME])
  await expect(
    provisionner({ db, executor: executeur().executor, adapter, serveurId: id }, plan),
  ).rejects.toThrow(/proposition validée/)
})

// --- Le provisioning nominal ------------------------------------------------

test('un provisioning conforme enchaîne sans validation, puis ferme le champ libre', async () => {
  const id = await creerServeur('vierge')
  const { plan, adapter } = planAvec([CONFORME])
  const espion = executeur()

  const r = await provisionner({ db, executor: espion.executor, adapter, serveurId: id }, plan)

  expect(r.ok).toBe(true)
  expect(r.iterations).toBe(1)
  // Aucune validation intermédiaire : les deux opérations sont parties d'affilée.
  expect(espion.scripts).toHaveLength(2)
  expect(await listInbox(db, { type: 'approval' })).toHaveLength(0)

  // Le point de non-retour.
  expect(r.ferme).toBe(true)
  expect((await lireServeur(db, id)).etat).toBe('en_service')
})

test('un serveur provisionné ne redevient jamais vierge, même vidé', async () => {
  const id = await creerServeur('vierge')
  const { plan, adapter } = planAvec([CONFORME])
  await provisionner({ db, executor: executeur().executor, adapter, serveurId: id }, plan)

  // Sans le sens unique, il suffirait d'effacer un répertoire pour retrouver
  // le champ libre.
  await expect(
    db.updateTable('serveurs').set({ etat: 'vierge' }).where('id', '=', id).execute(),
  ).rejects.toThrow(/ne redevient jamais vierge/)
})

test('un écart mineur ne bloque pas : le juge constate, il ne décide pas', async () => {
  const id = await creerServeur('vierge')
  const { plan, adapter } = planAvec([MINEUR])

  const r = await provisionner({ db, executor: executeur().executor, adapter, serveurId: id }, plan)
  expect(r.ok).toBe(true)
  expect(r.rapport?.ecarts).toHaveLength(1)
  expect((await lireServeur(db, id)).etat).toBe('en_service')
})

// --- Ce qui ne va pas -------------------------------------------------------

test('un écart bloquant déclenche une correction, puis s’arrête à la borne', async () => {
  const id = await creerServeur('vierge')
  const { plan, adapter } = planAvec([BLOQUANT])
  const espion = executeur()

  const r = await provisionner({ db, executor: espion.executor, adapter, serveurId: id }, plan)

  expect(r.ok).toBe(false)
  expect(r.iterations).toBe(MAX_ITERATIONS_PROVISION)
  // Le serveur RESTE vierge : rien n'a abouti, le prochain essai repart en
  // champ libre plutôt que d'exiger une validation pour rien.
  expect(r.ferme).toBe(false)
  expect((await lireServeur(db, id)).etat).toBe('vierge')

  const alertes = await listInbox(db, { type: 'alert' })
  expect(alertes).toHaveLength(1)
  expect(alertes[0]?.payload.cause).toMatch(/bloquant/)
})

test('un bloquant corrigé au deuxième tour laisse passer', async () => {
  const id = await creerServeur('vierge')
  const { plan, adapter } = planAvec([BLOQUANT, CONFORME])

  const r = await provisionner({ db, executor: executeur().executor, adapter, serveurId: id }, plan)
  expect(r.ok).toBe(true)
  expect(r.iterations).toBe(2)
})

test('une application interrompue n’est jamais jugée conforme', async () => {
  const id = await creerServeur('vierge')
  // Le juge dirait « conforme » si on le lui demandait : c'est justement ce
  // qu'il ne faut pas faire quand rien n'a abouti.
  const { plan, adapter } = planAvec([CONFORME])
  const espion = executeur((s) => s.includes('reload'))

  const r = await provisionner({ db, executor: espion.executor, adapter, serveurId: id }, plan)

  expect(r.ok).toBe(false)
  expect(r.rapport).toBeNull()
  expect(r.application.nonTentees).toEqual([])
  expect((await lireServeur(db, id)).etat).toBe('vierge')

  const alertes = await listInbox(db, { type: 'alert' })
  expect(alertes[0]?.title).toContain('Provisioning échoué')
  expect(alertes[0]?.payload.ctx).toContain('No space left on device')
})

// --- Les critères -----------------------------------------------------------

test('les critères sont DÉRIVÉS des opérations, jamais écrits par le juge', () => {
  const criteres = criteresDepuisOperations(OPERATIONS)
  // Un juge qui écrirait lui-même ses critères se noterait lui-même.
  expect(criteres).toHaveLength(2)
  expect(criteres[0]).toContain('nginx')
  expect(criteres[0]).toMatch(/doit être présent/)
  expect(criteres[1]).toMatch(/doit être actif/)
})

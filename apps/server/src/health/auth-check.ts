import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/types'
import type { Mailer } from '../integrations/mailer'
import type { RuntimeAdapter } from '../runtime/types'

const ALERT_KEY = 'auth.runtime_indisponible'

export interface AuthHealthcheckResult {
  ok: boolean
  error?: string
}

export interface AuthHealthcheckDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  mailer: Mailer
  alertTo: string
  /** Délai au-delà duquel le runtime est considéré en panne. Défaut : 30 s. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Vérifie que le runtime agent est réellement joignable et authentifié, en
 * déléguant à `adapter.healthcheck()`.
 *
 * L'appel est borné dans le temps : un runtime injoignable fait pendre le SDK
 * (réessais réseau) au lieu d'échouer, ce qui bloquerait le cron de 15 minutes
 * indéfiniment — l'outil resterait muet exactement quand il devrait alerter.
 * Un dépassement de délai est donc traité comme une panne, pas comme un doute.
 *
 * En cas d'échec : un item d'inbox `alert` + un email immédiat. L'alerte n'est
 * pas dupliquée tant qu'une alerte de même cause est encore ouverte — sans ça,
 * un cron toutes les 15 minutes noierait l'inbox.
 */
export async function runAuthHealthcheck(
  deps: AuthHealthcheckDeps,
): Promise<AuthHealthcheckResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined

  let result: { ok: boolean; error?: string }
  try {
    result = await Promise.race([
      deps.adapter.healthcheck(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Pas de réponse du runtime après ${timeoutMs} ms.`)),
          timeoutMs,
        )
      }),
    ])
  } catch (err) {
    // Un adapter qui lève au lieu de renvoyer {ok:false} reste une panne.
    result = { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    // Sans ça, le timer garde le process en vie jusqu'à son échéance.
    if (timer) clearTimeout(timer)
  }

  if (result.ok) {
    await closeAlert(deps)
    return { ok: true }
  }

  const error = result.error ?? 'Cause inconnue.'
  await raiseAlert(deps, error)
  return { ok: false, error }
}

/**
 * L'authentification est revenue : l'alerte ouverte devient fausse.
 *
 * Elle n'était jamais fermée. Une panne passagère laissait donc une alerte
 * DÉFINITIVE, affichée sur tous les écrans par le bandeau permanent — et une
 * alerte qui ment est pire qu'une alerte absente : elle apprend à ne plus
 * lire les alertes. Constaté en production, où elle était restée ouverte
 * alors que l'authentification fonctionnait.
 *
 * Fermée en `done` et non `dismissed` : le problème a bien été résolu, il n'a
 * pas été écarté. La trace reste lisible dans l'historique de l'inbox.
 */
async function closeAlert(deps: AuthHealthcheckDeps): Promise<void> {
  await deps.db
    .updateTable('inbox_items')
    .set({
      status: 'done',
      human_response: JSON.stringify({
        resolvedBy: 'healthcheck',
        raison: "l'authentification agent répond de nouveau",
      }),
      // `resolved_at` est ce que le JOURNAL lit : `listDecisions` filtre sur
      // `resolved_at is not null` (journal/repo.ts). L'omettre — ce que ce
      // code faisait — rendait la fermeture invisible : l'alerte cessait de
      // mentir, mais disparaissait sans que rien ne consigne qu'elle avait
      // été résolue. Le même travers, déplacé d'un cran.
      //
      // Trouvé en production par la vérification de la correction précédente,
      // pas par un test.
      resolved_at: new Date(),
    })
    .where('type', '=', 'alert')
    .where('status', '=', 'open')
    .where(sql<boolean>`payload->>'cause' = ${ALERT_KEY}`)
    .execute()
}

async function raiseAlert(deps: AuthHealthcheckDeps, error: string): Promise<void> {
  // `payload->>'cause'` plutôt que l'API JSON de Kysely : l'opérateur SQL brut
  // est sans ambiguïté et la clause reste lisible.
  const existing = await deps.db
    .selectFrom('inbox_items')
    .select('id')
    .where('type', '=', 'alert')
    .where('status', '=', 'open')
    .where(sql<boolean>`payload->>'cause' = ${ALERT_KEY}`)
    .executeTakeFirst()

  if (existing) return

  await deps.db
    .insertInto('inbox_items')
    .values({
      type: 'alert',
      title: 'Authentification agent indisponible',
      payload: JSON.stringify({ cause: ALERT_KEY, error }),
      archive_to_client: false,
    })
    .execute()

  await deps.mailer.send({
    to: deps.alertTo,
    subject: '[silithid] Authentification agent indisponible',
    text: [
      "Le healthcheck n'a pas pu ouvrir de session agent.",
      '',
      `Erreur : ${error}`,
      '',
      "Tant que ce n'est pas résolu, aucune boucle ne peut avancer.",
    ].join('\n'),
  })
}

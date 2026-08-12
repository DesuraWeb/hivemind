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

  if (result.ok) return { ok: true }

  const error = result.error ?? 'Cause inconnue.'
  await raiseAlert(deps, error)
  return { ok: false, error }
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
    subject: '[hivemind] Authentification agent indisponible',
    text: [
      "Le healthcheck n'a pas pu ouvrir de session agent.",
      '',
      `Erreur : ${error}`,
      '',
      "Tant que ce n'est pas résolu, aucune boucle ne peut avancer.",
    ].join('\n'),
  })
}

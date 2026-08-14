import type { Kysely } from 'kysely'
import { RESERVE_UNLOCK_SETTINGS_KEY, parseUnlockUntil } from '../budget/reserve'
import { decideBudget, loadBudgetThresholds } from '../budget/scheduler'
import type { Database } from '../db/types'
import type { RuntimeAdapter } from '../runtime/types'
import type { SettingsStore } from '../settings/store'

/**
 * L'état du système, tel que `Etats systeme.dc.html` le décrit.
 *
 * ## La règle du pack, reprise telle quelle
 *
 * « Une dégradation = un seul bandeau, jamais de modale bloquante », et
 * surtout : « le système ne parle que quand quelque chose se dégrade ».
 * Nominal, c'est le silence. Cette route rend donc une liste **vide** la
 * plupart du temps, et c'est le résultat attendu.
 *
 * ## D'où viennent les signaux, et lesquels manquent
 *
 * Le pack décrit quatre scénarios. Trois seulement sont mesurables :
 *
 * - **Authentification** — le cron `auth.healthcheck` tourne toutes les 15 min
 *   et lève un item d'inbox quand le runtime ne répond plus
 *   (`health/auth-check.ts`). On lit cet item, on ne refait pas le contrôle :
 *   `/api/health/auth` ouvre une vraie session d'agent, donc il coûte. Un
 *   bandeau qui se paierait à chaque affichage de page serait absurde.
 * - **Fenêtre de budget** — la jauge est gratuite (`runtime/usage.ts`), donc
 *   mesurée à la demande. Épuisée, elle donne la date de reprise.
 * - **Jauge indisponible** — le scheduler lève déjà un item quand il ne peut
 *   plus rien mesurer, et le dire compte : dans cet état, plus aucune pause
 *   automatique ne protège la réserve.
 *
 * **Gmail déconnecté n'est PAS mesurable.** Aucune route ne dit si
 * l'intégration est vivante, et déduire « connecté » de la présence d'un
 * secret dans le coffre affirmerait un état jamais vérifié — c'est
 * exactement le raisonnement qui a fait retirer le bloc « Connexions » de
 * l'écran Réglages. On ne l'invente pas.
 */

export type DegradationKind = 'auth' | 'budget' | 'gauge' | 'security'

export interface Degradation {
  kind: DegradationKind
  /** Une phrase, lisible telle quelle dans le bandeau. */
  text: string
  /** Ce qui se passe pour les boucles pendant ce temps. Le pack y tient, et il a raison. */
  loops: string
  /** Lien d'action, quand il y en a un de réel. Jamais un bouton qui ne fait rien. */
  action?: { label: string; to: string }
}

export interface SystemStatus {
  /** Vide = nominal. Le système ne parle que quand quelque chose se dégrade. */
  degradations: Degradation[]
}

export interface SystemStatusDeps {
  db: Kysely<Database>
  settings: SettingsStore
  adapter: Pick<RuntimeAdapter, 'usage'>
}

export async function readSystemStatus(deps: SystemStatusDeps): Promise<SystemStatus> {
  const degradations: Degradation[] = []

  // --- Alertes déjà levées, lues et non refaites ---------------------------
  const alerts = await deps.db
    .selectFrom('inbox_items')
    .select(['subtype', 'payload'])
    .where('type', '=', 'alert')
    .where('status', '=', 'open')
    .execute()

  const causeOf = (payload: unknown): string =>
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { cause?: unknown }).cause === 'string'
      ? (payload as { cause: string }).cause
      : ''

  for (const alert of alerts) {
    const cause = causeOf(alert.payload)
    if (cause.startsWith('auth.')) {
      degradations.push({
        kind: 'auth',
        text: "Le runtime ne répond plus · les boucles s'arrêtent proprement, leur état est sauvegardé.",
        loops: 'endormies · reprise exactement où elles en étaient',
        action: { label: 'Voir le diagnostic', to: '/reglages' },
      })
    } else if (cause.startsWith('budget.')) {
      degradations.push({
        kind: 'gauge',
        // Le point qui compte : ce n'est pas « on ne sait pas », c'est « plus
        // rien ne protège la réserve ».
        text: 'Jauge de consommation indisponible · aucune pause automatique ne protège la réserve.',
        loops: 'les boucles continuent, sans garde-fou budgétaire',
        action: { label: 'Voir le budget', to: '/reglages' },
      })
    } else if (alert.subtype === 'security_selfmod') {
      degradations.push({
        kind: 'security',
        text: 'Une boucle modifie la frontière de sécurité · un item attend votre relecture.',
        loops: 'les boucles continuent · ceci ne bloque rien, ça se voit',
        action: { label: "Ouvrir l'inbox", to: '/inbox' },
      })
    }
  }

  // --- Fenêtre de budget, mesurée (gratuit) --------------------------------
  const now = new Date()
  const thresholds = await loadBudgetThresholds(deps.settings)
  const reserve = parseUnlockUntil(await deps.settings.get(RESERVE_UNLOCK_SETTINGS_KEY), now)

  let snapshot = null
  try {
    snapshot = await deps.adapter.usage()
  } catch {
    // Un runtime injoignable est déjà couvert par l'alerte d'authentification
    // ci-dessus, si le cron l'a vu. Ne pas en fabriquer une seconde ici.
    snapshot = null
  }

  const decision = decideBudget(snapshot, thresholds, now, reserve)
  if (decision.gauge && decision.action === 'pause') {
    const resets = snapshot?.resetsAt
      ? ` · reprise vers ${snapshot.resetsAt.toLocaleTimeString('fr-FR', {
          hour: '2-digit',
          minute: '2-digit',
        })}`
      : ''
    degradations.push({
      kind: 'budget',
      text: `Fenêtre de consommation à ${decision.gauge.pct} %${resets} · la réserve reste ${reserve.state}.`,
      loops: 'en pause budgétaire · le travail reprend seul quand la fenêtre se vide',
      // Puiser dans la réserve est une décision explicite, jamais un
      // automatisme : le bandeau propose, il ne fait pas.
      action: { label: 'Entamer la réserve', to: '/reglages' },
    })
  }

  return { degradations }
}

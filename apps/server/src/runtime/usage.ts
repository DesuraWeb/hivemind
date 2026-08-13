import { query } from '@anthropic-ai/claude-agent-sdk'
import { resolveToolPolicy } from './tools'
import type { UsageSnapshot } from './types'

/**
 * La consommation du compte, mesurée pour de vrai (Phase 5, Task 1).
 *
 * ## Ce que la Phase 1 avait conclu, et pourquoi c'était faux
 *
 * Le commentaire de tête de `claude.ts` affirmait depuis la Phase 1 qu'« il
 * n'existe AUCUNE fonction exportée pour interroger la consommation par
 * fenêtre en dehors d'une session active ». C'est faux pour le SDK 0.3.227 :
 * l'objet `Query` porte une méthode d'usage. Elle n'est pas *exportée* comme
 * fonction libre — d'où, sans doute, la conclusion trop rapide — mais elle
 * répond, et sans session au sens où on l'entendait.
 *
 * Le repli d'origine (capter `rate_limit_event` pendant les `send()`) ne
 * pouvait de toute façon pas marcher : `scripts/diag-rate-limit.ts` montre que
 * l'évènement arrive bien, sous le bon nom, mais que son `rate_limit_info` ne
 * contient PAS `utilization` — le SDK le type optionnel, le serveur ne
 * l'envoie pas. `captureRateLimit` sortait donc en `return` silencieux à
 * chaque évènement depuis le premier jour, et `usage()` répondait
 * `available: false` en permanence.
 *
 * ## Pourquoi c'est gratuit
 *
 * Règle du garant : « jamais de tokens dépensés juste pour mesurer. » Mesuré
 * avec `scripts/diag-usage-api.ts` : réponse en ~1 s, `total_cost_usd: 0`,
 * **sans jamais itérer le flux**. C'est le point clé — le prompt passé à
 * `query()` n'est envoyé qu'à la première itération de l'AsyncGenerator. On
 * n'itère pas, donc aucun tour de modèle n'a lieu ; seul le canal de contrôle
 * est utilisé. Ne jamais « améliorer » ce code en consommant le flux.
 *
 * ## Pourquoi on s'en méfie quand même
 *
 * Le nom de la méthode est un avertissement du SDK :
 * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. Elle peut
 * disparaître d'une version à l'autre. D'où l'accès structurel (pas d'import
 * de type), le `typeof !== 'function'` explicite, et le repli honnête sur
 * `available: false` — qui interdit au scheduler de mettre quoi que ce soit en
 * pause, contrat écrit dans `types.ts`.
 */

/** Nom de la méthode de contrôle. Isolé ici : c'est le point de rupture le plus probable. */
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'

/**
 * Une fenêtre telle que le SDK la renvoie. `utilization` est un pourcentage
 * 0-100 (pas un ratio 0-1, contrairement à `rate_limit_event`), `resets_at`
 * une date ISO 8601. Les deux sont nullables même quand la fenêtre existe.
 */
interface RateWindow {
  utilization?: number | null
  resets_at?: string | null
}

/**
 * Forme minimale exploitée de la réponse. Volontairement plus permissive que
 * le type du SDK : à l'exécution, `rate_limits` porte des clés absentes du
 * `.d.ts` (`seven_day_cowork`, `tangelo`, `nimbus_quill`…). On itère donc les
 * entrées plutôt que de nommer des champs qui bougeront.
 */
export interface UsageResponse {
  rate_limits_available?: boolean
  rate_limits?: Record<string, unknown> | null
}

function asWindow(value: unknown): RateWindow | null {
  if (value === null || typeof value !== 'object') return null
  const w = value as RateWindow
  return typeof w.utilization === 'number' ? w : null
}

/**
 * Réduit les fenêtres du SDK aux deux jauges du pack DA.
 *
 * Les variantes hebdomadaires sont nombreuses et changeantes (`seven_day`,
 * `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, et des noms
 * non documentés). On prend le MAXIMUM de toutes celles qui portent un
 * nombre : sous-estimer la conso ferait tourner le scheduler trop longtemps,
 * la surestimer ne coûte qu'une pause prématurée. Même arbitrage que
 * `captureRateLimit`, pour la même raison.
 *
 * Les clés inconnues qui ne commencent pas par `seven_day` sont ignorées : un
 * bucket dont on ne sait pas ce qu'il compte ne doit pas piloter une pause.
 *
 * Fonction pure, testée sans SDK ni réseau.
 */
export function foldRateLimits(res: UsageResponse): UsageSnapshot | null {
  // `false` explicite : clé API, Bedrock, Vertex — les limites de plan ne
  // s'appliquent pas, il n'y a rien d'honnête à afficher.
  if (res.rate_limits_available === false) return null
  if (!res.rate_limits || typeof res.rate_limits !== 'object') return null

  let fiveHourPct = 0
  let sevenDayPct = 0
  let seen = false
  let resetsAt: Date | undefined

  for (const [key, value] of Object.entries(res.rate_limits)) {
    const win = asWindow(value)
    if (!win || typeof win.utilization !== 'number') continue

    if (key === 'five_hour') {
      fiveHourPct = win.utilization
      seen = true
      // La date de remise à zéro affichée par le pack DA (`BUDGET.reset`) est
      // celle de la fenêtre de 5 h : c'est la seule qui bouge dans la journée.
      if (win.resets_at) {
        const parsed = new Date(win.resets_at)
        if (!Number.isNaN(parsed.getTime())) resetsAt = parsed
      }
    } else if (key.startsWith('seven_day')) {
      sevenDayPct = Math.max(sevenDayPct, win.utilization)
      seen = true
    }
  }

  if (!seen) return null
  // `exactOptionalPropertyTypes` : une remise à zéro absente doit être une clé
  // absente, pas une clé qui vaut undefined.
  return {
    fiveHourPct,
    sevenDayPct,
    available: true,
    sampledAt: new Date(),
    ...(resetsAt ? { resetsAt } : {}),
  }
}

/** Ce qu'on attend d'un objet `Query` pour le sonder. Structurel : aucun couplage au type du SDK. */
export interface UsageProbeTarget {
  interrupt?: () => Promise<unknown>
}

/**
 * Interroge un objet `Query` déjà construit. Séparé de `probeUsage` pour être
 * testable avec un faux objet, sans SDK ni réseau.
 *
 * Toute erreur devient `null` : une sonde de budget qui fait tomber l'appelant
 * serait un remède pire que le mal. `interrupt()` en `finally` est
 * obligatoire — sans lui le sous-processus du SDK survit au process, et on
 * accumule un orphelin à chaque tick du cron.
 */
export async function probeUsageOn(target: UsageProbeTarget): Promise<UsageSnapshot | null> {
  const method = (target as Record<string, unknown>)[USAGE_METHOD]
  if (typeof method !== 'function') return null

  try {
    const res = (await (method as () => Promise<unknown>).call(target)) as UsageResponse
    return foldRateLimits(res)
  } catch {
    return null
  } finally {
    try {
      await target.interrupt?.()
    } catch {
      // L'interruption d'une session qui n'a jamais rien envoyé peut échouer :
      // sans intérêt pour l'appelant, on ne masque rien d'utile ici.
    }
  }
}

/**
 * Ouvre un `query()` éphémère, le sonde, le referme. Le prompt n'est jamais
 * envoyé : on n'itère pas le flux (voir la note de tête).
 */
export async function probeUsage(): Promise<UsageSnapshot | null> {
  const { sdkOptions } = resolveToolPolicy({ bash: false, fs: 'none', mcp: [] })
  const q = query({
    prompt: "Sonde de budget — ce prompt n'est jamais envoyé.",
    options: { ...sdkOptions, maxTurns: 1 },
  })
  return probeUsageOn(q as unknown as UsageProbeTarget)
}

/**
 * Diagnostic ciblé : `usage()` peut-il enfin dire la vérité, et à quel prix ?
 *
 * Constat de la Phase 1, écrit en tête de `runtime/claude.ts` : « il n'existe
 * AUCUNE fonction exportée pour interroger la consommation par fenêtre en
 * dehors d'une session active ». Ce constat est faux pour la version 0.3.227
 * du SDK, qui expose sur l'objet `Query` :
 *
 *     usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
 *       → { session: {...}, subscription_type, rate_limits_available,
 *           rate_limits: { five_hour: { utilization: 0-100, resets_at }, ... } }
 *
 * C'est exactement la jauge du pack DA (BUDGET.w5h / w7j). Deux choses
 * décident si on peut s'en servir, et aucune ne se devine :
 *
 *   1. LE PRIX. Règle du garant : « jamais de tokens dépensés juste pour
 *      mesurer. » Si l'appel exige de consommer le flux (donc un vrai tour de
 *      modèle), il est disqualifié comme sonde périodique. S'il passe par le
 *      canal de contrôle sans itérer le flux, il est gratuit.
 *   2. LA DISPONIBILITÉ. `rate_limits_available` est faux pour une session à
 *      clé API, Bedrock ou Vertex. Il faut savoir de quel côté on est ici.
 *
 * Le nom même de la méthode est un avertissement du SDK (« DO NOT RELY ON
 * THIS API YET »). Ce script sert à décider en connaissance de cause, pas à
 * s'en remettre à une promesse d'API.
 *
 *   pnpm --filter @silithid/server exec tsx scripts/diag-usage-api.ts
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { loadEnv } from '../src/env'
import { resolveToolPolicy } from '../src/runtime/tools'

loadEnv()

const { sdkOptions } = resolveToolPolicy({ bash: false, fs: 'none', mcp: [] })

/**
 * Le prompt ne sera JAMAIS envoyé si l'appel de contrôle n'exige pas d'itérer
 * le flux : c'est précisément ce qu'on mesure. On le rend reconnaissable pour
 * le repérer dans la conso si jamais il partait quand même.
 */
const q = query({
  prompt: 'DIAG-USAGE-API — ce prompt ne devrait jamais être envoyé.',
  options: { ...sdkOptions, maxTurns: 1 },
})

console.log(`── Appel sans itérer le flux ${'─'.repeat(37)}`)
const startedAt = Date.now()
try {
  const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
  const ms = Date.now() - startedAt

  console.log(`  a répondu en ${ms} ms\n`)
  console.log(`  abonnement ............ ${usage.subscription_type ?? '(aucun — clé API ou 3P)'}`)
  console.log(`  limites disponibles ... ${usage.rate_limits_available}`)
  console.log(`  coût de la session .... ${usage.session.total_cost_usd} USD`)
  console.log(`    (0 confirme que la mesure elle-même n'a rien consommé)\n`)

  console.log(`── Les fenêtres ${'─'.repeat(50)}`)
  console.log(`  ${JSON.stringify(usage.rate_limits, null, 2)}\n`)

  console.log(`── Lecture ${'─'.repeat(55)}`)
  if (!usage.rate_limits_available) {
    console.log('  Les limites de plan ne s appliquent pas à cette session.')
    console.log('  Le scheduler ne peut pas afficher de pourcentage honnête par cette voie.')
  } else if (usage.session.total_cost_usd === 0) {
    console.log('  GRATUIT et DISPONIBLE : la sonde périodique est possible telle quelle.')
    console.log('  `usage()` peut enfin retourner available: true avec de vrais pourcentages.')
  } else {
    console.log(`  DISPONIBLE mais la session a coûté ${usage.session.total_cost_usd} USD.`)
    console.log('  À confronter à la règle « jamais de tokens juste pour mesurer ».')
  }
} catch (err) {
  console.log(`  ÉCHEC après ${Date.now() - startedAt} ms`)
  console.log(`  ${err instanceof Error ? err.message : String(err)}\n`)
  console.log(`── Lecture ${'─'.repeat(55)}`)
  console.log("  L'appel de contrôle n'aboutit pas sans flux consommé, ou pas du tout.")
  console.log('  Reste la capture opportuniste pendant les send() actifs.')
} finally {
  // Sans ça le sous-processus du SDK reste vivant et le script ne rend pas la main.
  await q.interrupt?.().catch(() => {})
}

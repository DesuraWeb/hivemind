/**
 * Diagnostic ciblé : le SDK pousse-t-il RÉELLEMENT un `rate_limit_event` ?
 *
 * Tout le scheduler de budget repose dessus. `captureRateLimit`
 * (runtime/claude.ts) l'écoute depuis la Phase 1, et après plusieurs milliers
 * de tokens réels dépensés, `usage()` répond toujours `available: false` —
 * c'est-à-dire qu'aucun évènement n'a jamais été vu. Deux lectures possibles,
 * et elles n'appellent pas du tout le même travail :
 *
 *   A. L'évènement n'arrive qu'à l'approche d'une limite. Le scheduler est
 *      constructible, mais sa jauge restera vide en usage normal — donc sa
 *      règle de péremption (« > 90 min : jauge inconnu, dernière valeur + 10
 *      points ») serait en fait le comportement nominal, pas la dégradation.
 *   B. L'évènement porte un autre nom, ou vit ailleurs (`result`, un champ
 *      annexe). Alors `captureRateLimit` écoute la mauvaise chose et c'est un
 *      bug, pas une limite du SDK.
 *
 * Ce script ne devine pas : il fait UN échange minimal (« Réponds : OK »,
 * quelques dizaines de tokens) et imprime le type de CHAQUE message reçu, plus
 * tout objet contenant de près ou de loin une information de limite de débit,
 * quel que soit son nom. On lit ensuite le verdict dans la sortie.
 *
 *   pnpm --filter @silithid/server exec tsx scripts/diag-rate-limit.ts
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { loadEnv } from '../src/env'
import { createClaudeAdapter } from '../src/runtime/claude'
import { resolveToolPolicy } from '../src/runtime/tools'

loadEnv()

/** Repère un porteur d'info de limite de débit sans présumer de son nom. */
const RATE_HINTS = ['rate_limit', 'ratelimit', 'utilization', 'resets_at', 'resetsAt']

function hintsIn(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object') return []
  const found: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key
    if (RATE_HINTS.some((h) => key.toLowerCase().includes(h.toLowerCase()))) {
      found.push(`${here} = ${JSON.stringify(child)}`)
    }
    found.push(...hintsIn(child, here))
  }
  return found
}

const { sdkOptions } = resolveToolPolicy({ bash: false, fs: 'none', mcp: [] })

console.log(`── Échange minimal ${'─'.repeat(47)}`)
const types: string[] = []
const hits: string[] = []

for await (const msg of query({
  prompt: 'Réponds exactement : OK',
  options: { ...sdkOptions, maxTurns: 1 },
})) {
  types.push(msg.type)
  const found = hintsIn(msg)
  if (found.length > 0) {
    hits.push(`  [${msg.type}]`)
    for (const f of found) hits.push(`    ${f}`)
  }
}

console.log(`  messages reçus : ${types.join(' · ')}\n`)

console.log(`── Porteurs d'info de limite de débit ${'─'.repeat(28)}`)
if (hits.length === 0) {
  console.log('  AUCUN. Rien dans ce flux ne parle de limite de débit, sous aucun nom.\n')
} else {
  for (const line of hits) console.log(line)
  console.log('')
}

console.log(`── Ce que voit le scheduler ${'─'.repeat(38)}`)
const snapshot = await createClaudeAdapter().usage()
console.log(`  ${JSON.stringify(snapshot)}\n`)

console.log(`── Lecture ${'─'.repeat(55)}`)
if (hits.length === 0) {
  console.log("  Hypothèse A : l'évènement n'est pas poussé lors d'un échange ordinaire.")
  console.log('  Le scheduler ne peut pas se fonder dessus comme source nominale.')
} else if (types.includes('rate_limit_event')) {
  console.log('  Le nom écouté par captureRateLimit est le bon : la source existe.')
} else {
  console.log("  Hypothèse B : l'info existe mais PAS sous `type: rate_limit_event`.")
  console.log('  captureRateLimit écoute la mauvaise chose — voir les chemins ci-dessus.')
}

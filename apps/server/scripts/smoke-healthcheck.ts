// Vérifie que le healthcheck détecte réellement l'état de l'authentification.
// Consomme quelques tokens (un échange minimal).
//
//   pnpm --filter @hivemind/server exec tsx scripts/smoke-healthcheck.ts [timeoutMs]
//
// L'appel est borné : un runtime injoignable fait pendre le SDK au lieu
// d'échouer. Pour le constater, forcer une adresse morte :
//   ANTHROPIC_BASE_URL=http://127.0.0.1:9 pnpm ... scripts/smoke-healthcheck.ts 5000

import { createClaudeAdapter } from '../src/runtime/claude'

const timeoutMs = Number(process.argv[2] ?? 30_000)

const t0 = Date.now()
let timer: NodeJS.Timeout | undefined

const result = await Promise.race([
  createClaudeAdapter().healthcheck(),
  new Promise<{ ok: false; error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: `Pas de réponse du runtime après ${timeoutMs} ms.` }),
      timeoutMs,
    )
  }),
])
if (timer) clearTimeout(timer)

console.log(`healthcheck -> ${JSON.stringify(result)} (${Date.now() - t0} ms)`)
process.exit(result.ok ? 0 : 1)

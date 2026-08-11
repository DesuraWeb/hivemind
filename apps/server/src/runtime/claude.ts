import type { RuntimeAdapter } from './types'

/**
 * Bouchon temporaire : la vraie implémentation arrive en Task 10.
 *
 * Ce fichier existe uniquement pour que `tsc` puisse résoudre l'import
 * dynamique de `./claude` dans `runtime/index.ts` (`moduleResolution:
 * "bundler"` exige que le module existe pour être type-checké, même quand
 * l'import est dynamique). Tant que `RUNTIME_ADAPTER=fake`, ce code n'est
 * jamais chargé ni exécuté. La Task 10 remplace ce fichier en entier.
 */
export function createClaudeAdapter(): RuntimeAdapter {
  throw new Error('ClaudeAdapter non implémenté (Task 10)')
}

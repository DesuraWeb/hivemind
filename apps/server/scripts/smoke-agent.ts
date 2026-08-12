/**
 * Vérification manuelle de la Task 10 : un agent réel écrit un fichier
 * dans un dépôt jetable, et on constate le résultat sur le disque.
 * Consomme des tokens. Lancer avec : pnpm --filter @silithid/server exec tsx scripts/smoke-agent.ts
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClaudeAdapter } from '../src/runtime/claude'
import { createThrowawayRepo } from '../src/runtime/worktree'

const repo = await createThrowawayRepo()
console.log(`Worktree : ${repo.path}`)

const adapter = createClaudeAdapter()
const session = await adapter.createSession({
  roleKey: 'dev',
  systemPrompt: 'Tu es un développeur. Français, direct, pas de flatterie.',
  cwd: repo.path,
  tools: { bash: false, fs: 'write', mcp: [] },
  onEvent: (e) => {
    if (e.type === 'text') process.stdout.write(e.text)
    if (e.type === 'tool_use') console.log(`\n[outil] ${e.name}`)
    if (e.type === 'cost') console.log(`\n[coût] ${e.tokens} tokens`)
  },
})

const result = await adapter.send(
  session,
  "Crée un fichier BONJOUR.md contenant exactement la ligne « silithid est vivant ». Puis réponds 'fait'.",
)

console.log(`\n--- Résultat : isError=${result.isError}, coût=${result.costTokens}`)
console.log(`--- sdkSessionId : ${session.sdkSessionId ?? '(non fourni)'}`)

const content = await readFile(join(repo.path, 'BONJOUR.md'), 'utf8').catch(() => null)
if (content?.includes('silithid est vivant')) {
  console.log('✅ Le fichier a bien été écrit dans le worktree.')
} else {
  console.error('❌ BONJOUR.md absent ou incorrect. Contenu lu :', content)
  process.exitCode = 1
}

await repo.dispose()

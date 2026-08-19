/**
 * Diagnostic ciblé : un agent CONSULTE-T-IL la mémoire quand il devrait ?
 *
 * Toute la Phase 7 repose là-dessus. Archiver du savoir ne sert à rien si
 * personne ne le lit — et `client_kb.lookup` vient d'être câblé après avoir
 * été promis à trois rôles pendant six phases sans exister. Un agent qui ne
 * trouve pas un outil ne plante pas : il s'en passe. C'est précisément pour ça
 * que le manque a survécu si longtemps, et c'est pourquoi il faut MESURER
 * plutôt que supposer.
 *
 * ## La vérité terrain
 *
 * Une fiche client porte la réponse à une question que le cadrage rend
 * nécessaire (« qui valide les contenus ? »). Le prompt du garant lui dit :
 * « avant de poser une question, consulte la fiche client ».
 *
 * Un garant qui fonctionne appelle `client_kb.lookup` et ne pose pas la
 * question. Un garant qui l'ignore la pose — et il faut régler ça avant
 * d'écrire la moindre ligne de la Phase 7.
 *
 * On lit `AgentResult.toolCalls` : les appels RÉELLEMENT observés, pas le
 * texte de la réponse, qui pourrait prétendre avoir consulté sans l'avoir
 * fait.
 *
 *   pnpm --filter @silithid/server exec tsx scripts/diag-rappel.ts
 */

import { randomUUID } from 'node:crypto'
import { closeDb, getDb } from '../src/db/client'
import { loadEnv } from '../src/env'
import { CLIENT_KB_LOOKUP_TOOL, createClientKbSurface } from '../src/knowledge/client-kb'
import { createClaudeAdapter } from '../src/runtime/claude'

const env = loadEnv()
const db = getDb()
const adapter = createClaudeAdapter()

const NOM_CLIENT = `Atelier Diagnostic ${randomUUID().slice(0, 6)}`

const client = await db
  .insertInto('clients')
  .values({
    name: NOM_CLIENT,
    tone: 'Direct, vouvoiement, aucun jargon technique.',
    notes: JSON.stringify([
      {
        q: 'Qui valide les contenus avant mise en ligne ?',
        a: 'Marie, la gérante, directement · jamais son alternante. La prévenir 48 h avant.',
        source_item_id: 'diag',
        at: new Date().toISOString(),
      },
    ]),
  })
  .returning('id')
  .executeTakeFirstOrThrow()

console.log(`── Vérité terrain ${'─'.repeat(48)}`)
console.log(`  fiche « ${NOM_CLIENT} » créée`)
console.log('  elle contient : qui valide les contenus (Marie, jamais son alternante)')
console.log(
  "  attendu d'un garant correct : il appelle client_kb.lookup et NE POSE PAS la question\n",
)

const tools = { bash: false, fs: 'read' as const, mcp: ['client_kb', 'bus'] }
const kb = createClientKbSurface({ db, tools })

const session = await adapter.createSession({
  roleKey: 'garant',
  systemPrompt: [
    'Tu es le garant. Avant de poser une question à un humain, tu consultes la',
    'fiche client (`client_kb.lookup`) : la réponse y est peut-être déjà.',
    'Si tu trouves la réponse, tu ne poses pas la question.',
  ].join('\n'),
  cwd: env.WORKTREES_ROOT,
  tools,
  onEvent: () => {},
})

const result = await adapter.send(
  session,
  [
    `Projet pour le client « ${NOM_CLIENT} ».`,
    '',
    "Le step consiste à publier trois fiches produit. Avant de cadrer, tu dois savoir QUI valide les contenus avant mise en ligne, et s'il faut prévenir quelqu'un à l'avance.",
    '',
    "Réponds en une phrase : ce que tu as appris, et si tu dois poser une question à l'humain.",
  ].join('\n'),
  kb.sendOptions,
)

const appels = result.toolCalls ?? []
const aConsulte = appels.some((c) => c.name.endsWith(CLIENT_KB_LOOKUP_TOOL))

console.log(`── Ce que l'agent a RÉELLEMENT fait ${'─'.repeat(30)}`)
console.log(
  `  outils appelés : ${appels.length === 0 ? 'aucun' : appels.map((c) => c.name).join(', ')}`,
)
console.log(`  a consulté la fiche : ${aConsulte ? 'OUI' : 'NON'}\n`)
console.log(`── Sa réponse ${'─'.repeat(52)}`)
console.log(`${result.text.slice(0, 600)}\n`)

console.log(`── Lecture ${'─'.repeat(55)}`)
if (aConsulte) {
  const cite = /marie/i.test(result.text)
  console.log('  Le socle tient : l’agent consulte la mémoire quand on la lui donne.')
  console.log(
    cite
      ? '  Et il en a TIRÉ la réponse (« Marie » cité) — le rappel change son comportement.'
      : '  Réserve : il a consulté mais ne cite pas la réponse. À regarder de près.',
  )
} else {
  console.log('  ARRÊT. L’agent ne consulte pas la mémoire alors que son prompt le lui dit.')
  console.log('  Archiver du savoir ne servirait à rien : régler ça AVANT la Phase 7.')
}

await db.deleteFrom('clients').where('id', '=', client.id).execute()
await closeDb()
console.log('\n(fiche de diagnostic supprimée)')

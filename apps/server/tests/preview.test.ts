import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { createLocalPreviewTarget } from '../src/deploy/local-preview'
import { databaseUrl, loadEnv } from '../src/env'
import { closeBrowser } from '../src/integrations/playwright'
import { startStaticPreview } from '../src/integrations/preview'
import { appendMessage } from '../src/loop/bus'
import { createDeployingHandler } from '../src/loop/steps/deploying'

// Aucun réseau externe, aucun token consommé : tout tourne en local
// (`node:http` sur 127.0.0.1, worktrees dans un dossier temporaire).

const env = loadEnv()
const db = createDb(createPool(databaseUrl(env)))

beforeAll(async () => {
  await sql`drop schema public cascade; create schema public;`.execute(db)
  await runMigrations(db)
})

afterAll(async () => {
  await closeBrowser()
  await db.destroy()
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** `true` si un socket TCP arrive à se connecter à `port` sur 127.0.0.1. */
function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 300 })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

test('startStaticPreview sert un fichier réel du répertoire donné', async () => {
  const root = await tempDir('silithid-preview-serve-')
  await writeFile(join(root, 'index.html'), '<h1>Bonjour Silithid</h1>', 'utf8')
  await mkdir(join(root, 'about'))
  await writeFile(join(root, 'about', 'index.html'), '<p>À propos</p>', 'utf8')

  const preview = await startStaticPreview(root)
  try {
    const rootRes = await fetch(preview.url)
    expect(rootRes.status).toBe(200)
    expect(await rootRes.text()).toContain('Bonjour Silithid')
    expect(rootRes.headers.get('content-type')).toContain('text/html')

    const aboutRes = await fetch(`${preview.url}/about`)
    expect(aboutRes.status).toBe(200)
    expect(await aboutRes.text()).toContain('À propos')

    const missingRes = await fetch(`${preview.url}/does-not-exist`)
    expect(missingRes.status).toBe(404)

    // Une tentative d'évasion via `..` ne doit jamais sortir de `root`.
    const escapeRes = await fetch(`${preview.url}/../../etc/passwd`)
    expect(escapeRes.status).toBe(404)
  } finally {
    await preview.close()
  }
})

test('startStaticPreview.close() arrête le serveur proprement et libère le port', async () => {
  const root = await tempDir('silithid-preview-close-')
  await writeFile(join(root, 'index.html'), '<h1>Bye</h1>', 'utf8')

  const preview = await startStaticPreview(root)
  const port = Number(new URL(preview.url).port)

  expect(await portIsOpen(port)).toBe(true)

  // Une connexion gardée ouverte (keep-alive) ne doit pas empêcher `close()`
  // de se résoudre — c'est exactement pour ça que `preview.ts` appelle
  // `closeAllConnections()`.
  await fetch(preview.url, { headers: { connection: 'keep-alive' } })

  await preview.close()

  expect(await portIsOpen(port)).toBe(false)

  // Le port est réellement libre au niveau OS, pas seulement "fermé côté
  // objet JS" : un nouveau serveur peut se lier dessus explicitement.
  await new Promise<void>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
  })
})

/** globe → client → projet → step → run, juste assez pour poser une clé étrangère `run_id`. */
async function createFixtureRun(worktreePath: string | null): Promise<string> {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe Preview', slug: `globe-preview-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Projet Preview',
      slug: `projet-preview-${randomUUID()}`,
      repo_full_name: 'silithid/sandbox-preview',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'Step preview', specs: '## Déployer' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id, worktree_path: worktreePath })
    .returning('id')
    .executeTakeFirstOrThrow()
  return run.id
}

test('createDeployingHandler émet ci_red sur un worktree vide (aucun index.html servable)', async () => {
  const artifactsRoot = await tempDir('silithid-preview-artifacts-')
  const emptyWorktree = await tempDir('silithid-preview-empty-worktree-')
  // Un worktree "vide" au sens du plan : le répertoire existe (comme un
  // vrai worktree git) mais ne contient rien de servable — ni `public/`,
  // ni `dist/`, ni `build/`, ni `index.html` à la racine.
  const runId = await createFixtureRun(emptyWorktree)

  const handler = createDeployingHandler({ artifactsRoot, target: createLocalPreviewTarget() })
  const event = await handler(db, runId)

  expect(event.type).toBe('ci_red')
  if (event.type === 'ci_red') {
    expect(event.reason).toContain(emptyWorktree)
  }
})

test('createDeployingHandler émet ci_red quand runs.worktree_path est vide', async () => {
  const artifactsRoot = await tempDir('silithid-preview-artifacts-null-')
  const runId = await createFixtureRun(null)

  const handler = createDeployingHandler({ artifactsRoot, target: createLocalPreviewTarget() })
  const event = await handler(db, runId)

  expect(event.type).toBe('ci_red')
  if (event.type === 'ci_red') {
    expect(event.reason).toContain('aucun worktree enregistré')
  }
})

/**
 * Depuis la Phase 5 (Task 3), le handler `deploying` ne sait plus COMMENT on
 * déploie : il reçoit une `DeployTarget`. Ces trois tests le prouvent avec des
 * cibles factices — aucun serveur démarré, aucun token.
 */

test('une cible qui échoue produit ci_red en reprenant SA raison', async () => {
  const runId = await createFixtureRun(await tempDir('silithid-target-fail-'))
  const handler = createDeployingHandler({
    artifactsRoot: await tempDir('silithid-target-fail-art-'),
    target: {
      kind: 'faux-echec',
      async deploy() {
        return { ok: false, reason: 'le serveur de recette a refusé la connexion SSH' }
      },
    },
  })

  const event = await handler(db, runId)

  expect(event.type).toBe('ci_red')
  // La raison de la cible remonte telle quelle : c'est ce qu'un humain lira
  // dans l'alerte pour savoir quoi réparer. Une raison générique du handler
  // effacerait la seule information utile.
  if (event.type === 'ci_red') {
    expect(event.reason).toBe('le serveur de recette a refusé la connexion SSH')
  }
})

test('release() est appelé même quand la capture échoue', async () => {
  const runId = await createFixtureRun(await tempDir('silithid-target-release-'))
  let released = false
  const handler = createDeployingHandler({
    artifactsRoot: await tempDir('silithid-target-release-art-'),
    target: {
      kind: 'faux-injoignable',
      async deploy() {
        return {
          ok: true,
          // Port fermé : la capture va lever. Un release() sauté ici, c'est un
          // port qui fuit à chaque run raté.
          url: 'http://127.0.0.1:1',
          description: 'cible factice injoignable',
          release: async () => {
            released = true
          },
        }
      },
    },
  })

  // Le handler ne lève plus : une capture ratée devient un `ci_red` lisible,
  // que la machine à états sait transformer en alerte d'inbox. Ce qui compte
  // ici reste le `release()`, appelé quoi qu'il arrive.
  const event = await handler(db, runId)
  expect(event.type).toBe('ci_red')
  expect(released).toBe(true)
})

test("un déploiement raté n'écrit aucun message d'audit trompeur", async () => {
  const runId = await createFixtureRun(await tempDir('silithid-target-audit-'))
  const handler = createDeployingHandler({
    artifactsRoot: await tempDir('silithid-target-audit-art-'),
    target: {
      kind: 'faux-echec',
      async deploy() {
        return { ok: false, reason: 'peu importe' }
      },
    },
  })

  await handler(db, runId)

  // Rien n'a été déployé : la timeline ne doit pas laisser croire le contraire.
  const messages = await db
    .selectFrom('messages')
    .select('id')
    .where('run_id', '=', runId)
    .execute()
  expect(messages).toHaveLength(0)
})

test('une page introuvable produit ci_red, elle n arrive JAMAIS au juge', async () => {
  const worktree = await tempDir('silithid-404-worktree-')
  await mkdir(join(worktree, 'public'), { recursive: true })
  await writeFile(join(worktree, 'public', 'index.html'), '<!doctype html><h1>ok</h1>', 'utf8')
  const runId = await createFixtureRun(worktree)

  // Le cas reel : le garant rend un chemin de DEPOT au lieu d'un chemin
  // d'URL. L'apercu sert deja `public/` comme racine, donc `public/index.html`
  // repond 404. Sans garde-fou, le juge jugeait la page d'erreur et rendait
  // « 0 conformite, 6 ecarts » — pendant que le garant lisait la source et
  // concluait « conforme ». Le bon verdict, malgre un juge nourri de dechets.
  await appendMessage(db, {
    runId,
    fromRole: 'garant',
    toRole: 'dev',
    kind: 'prompt',
    body: 'Cadrage',
    meta: { pages_to_judge: ['public/index.html'] },
  })

  const handler = createDeployingHandler({
    artifactsRoot: await tempDir('silithid-404-artifacts-'),
    target: createLocalPreviewTarget(),
  })
  const event = await handler(db, runId)

  expect(event.type).toBe('ci_red')
  if (event.type === 'ci_red') {
    expect(event.reason).toContain('404')
    // La raison doit dire quoi corriger, pas seulement que ca a rate.
    expect(event.reason).toContain('RACINE SERVIE')
  }

  // Et surtout : aucun artifact enregistre. Rien a donner au juge.
  const artifacts = await db
    .selectFrom('artifacts')
    .select('id')
    .where('run_id', '=', runId)
    .execute()
  expect(artifacts).toHaveLength(0)
})

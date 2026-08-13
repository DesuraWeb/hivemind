import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { listRunArtifacts, recordCapturedPages, resolveArtifactPath } from '../src/artifacts/store'
import { createDb, createPool } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { databaseUrl, loadEnv } from '../src/env'
import { capturePages, closeBrowser } from '../src/integrations/playwright'

// Aucun réseau externe, aucun token consommé : la page servie est statique
// et locale (`node:http` sur 127.0.0.1), le juge visuel n'est pas sollicité
// ici — ce test couvre uniquement la capture et le stockage.

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

const PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: sans-serif; }
      .desktop-only { display: none; }
      @media (min-width: 1200px) { .desktop-only { display: block; } }
    </style>
  </head>
  <body>
    <h1>Bienvenue chez Silithid Test</h1>
    <p class="desktop-only">Section réservée au grand écran.</p>
  </body>
</html>`

/** Sert `PAGE_HTML` sur un port éphémère local, sans dépendance réseau externe. */
async function startStaticServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

/** Lit `width`/`height` depuis le chunk IHDR d'un PNG — pas de dépendance externe pour ce test. */
function pngDimensions(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

async function tempArtifactsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'silithid-artifacts-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** globe → client → projet → step → run, juste assez pour poser une clé étrangère `run_id`. */
async function createFixtureRun(): Promise<string> {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Globe Capture', slug: `globe-capture-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  const project = await db
    .insertInto('projects')
    .values({
      globe_id: globe.id,
      name: 'Projet Capture',
      slug: `projet-capture-${randomUUID()}`,
      repo_full_name: 'silithid/sandbox-capture',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const step = await db
    .insertInto('steps')
    .values({ project_id: project.id, position: 1, title: 'Step capture', specs: '## Capturer' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const run = await db
    .insertInto('runs')
    .values({ step_id: step.id })
    .returning('id')
    .executeTakeFirstOrThrow()
  return run.id
}

test('capturePages produit 3 PNG de dimensions distinctes et une extraction DOM par viewport', async () => {
  const site = await startStaticServer()
  cleanups.push(site.close)
  const artifactsRoot = await tempArtifactsRoot()
  const outDir = join(artifactsRoot, 'run-test')

  const captures = await capturePages(site.url, ['/'], outDir)

  expect(captures).toHaveLength(3)
  const byViewport = new Map(captures.map((c) => [c.viewport, c]))
  expect([...byViewport.keys()].sort()).toEqual(['desktop', 'mobile', 'tablette'])

  const dimensions = new Map<string, { width: number; height: number }>()
  for (const capture of captures) {
    expect(existsSync(capture.screenshotPath)).toBe(true)
    const buf = await readFile(capture.screenshotPath)
    // Signature PNG : les 8 premiers octets sont fixes pour tout fichier PNG valide.
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    dimensions.set(capture.viewport, pngDimensions(buf))

    // L'extraction DOM contient bien le texte attendu de la page servie.
    expect(existsSync(capture.domPath)).toBe(true)
    expect(capture.domText).toContain('Bienvenue chez Silithid Test')
  }

  // Les 3 viewports produisent des largeurs différentes : la preuve que
  // `setViewportSize` a réellement été appliqué avant chaque capture, pas
  // supposé.
  const widths = new Set([...dimensions.values()].map((d) => d.width))
  expect(widths.size).toBe(3)
  expect(dimensions.get('mobile')?.width).toBe(390)
  expect(dimensions.get('tablette')?.width).toBe(768)
  expect(dimensions.get('desktop')?.width).toBe(1440)

  // Le média-query `@media (min-width: 1200px)` ne se déclenche qu'au
  // viewport desktop : la preuve que le contenu DOM extrait dépend
  // réellement du redimensionnement, pas d'une capture figée.
  expect(byViewport.get('mobile')?.domText).not.toContain('Section réservée au grand écran.')
  expect(byViewport.get('desktop')?.domText).toContain('Section réservée au grand écran.')
})

test('recordCapturedPages stocke des chemins relatifs à ARTIFACTS_ROOT qui résolvent réellement sur disque', async () => {
  const site = await startStaticServer()
  cleanups.push(site.close)
  const artifactsRoot = await tempArtifactsRoot()
  const runId = await createFixtureRun()
  const outDir = join(artifactsRoot, runId)

  const captures = await capturePages(site.url, ['/'], outDir)
  const records = await recordCapturedPages(db, runId, artifactsRoot, captures)

  // 3 viewports × (1 screenshot + 1 dom_snapshot)
  expect(records).toHaveLength(6)
  expect(records.filter((r) => r.kind === 'screenshot')).toHaveLength(3)
  expect(records.filter((r) => r.kind === 'dom_snapshot')).toHaveLength(3)

  for (const record of records) {
    // Jamais un chemin absolu en base : ni un chemin qui commence par `/`,
    // ni un remontée hors racine.
    expect(record.path.startsWith('/')).toBe(false)
    expect(record.path).not.toContain('..')

    const resolved = resolveArtifactPath(artifactsRoot, record)
    expect(existsSync(resolved)).toBe(true)
  }

  const fromDb = await listRunArtifacts(db, runId)
  expect(fromDb.map((r) => r.id).sort()).toEqual(records.map((r) => r.id).sort())
  for (const record of fromDb) {
    expect(existsSync(resolveArtifactPath(artifactsRoot, record))).toBe(true)
  }
})

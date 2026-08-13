/**
 * DÉCISION D'ARCHITECTURE (Task 2, Phase 4) — CECI N'EST PAS LE STAGING RÉEL.
 *
 * Le juge visuel a besoin d'une URL SERVIE pour capturer des pages. Le vrai
 * staging (workflow GitHub, rsync vers cPanel) arrive à J11. En attendant,
 * ce module sert le worktree du run EN LOCAL, sur la machine qui exécute le
 * worker, sur un port éphémère (`listen(0, ...)`) — le temps d'une capture,
 * puis s'arrête. C'est un remplacement temporaire assumé, pas une
 * implémentation de déploiement : personne ne doit le prendre pour tel.
 * Voir `../loop/steps/deploying.ts` pour le handler d'état qui l'utilise.
 *
 * Pas de nouvelle dépendance : `node:http` suffit à ce besoin volontairement
 * minimal (pas de compression, pas de cache HTTP, pas d'ETag — un aperçu qui
 * ne vit que le temps d'une capture n'en a pas l'usage).
 */

import { readFile, stat } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

export interface StaticPreview {
  /** Base URL locale (`http://127.0.0.1:<port éphémère>`). */
  url: string
  /**
   * Arrête le serveur ET force la fermeture des connexions ouvertes
   * (keep-alive compris) — voir le commentaire sur `closeAllConnections`
   * ci-dessous pour pourquoi c'est nécessaire pour que cette promesse se
   * résolve de façon fiable.
   */
  close: () => Promise<void>
}

/**
 * Résout `requestedPath` à l'intérieur de `root`, en refusant toute évasion
 * via `..` dans l'URL demandée (traversal). Retourne `undefined` si la
 * requête sort de `root`.
 */
function resolveWithinRoot(root: string, requestedPath: string): string | undefined {
  const withoutQuery = requestedPath.split('?')[0] ?? '/'
  const decoded = decodeURIComponent(withoutQuery)
  const relative = decoded.replace(/^\/+/, '')
  const resolved = normalize(join(root, relative))
  if (resolved !== root && !resolved.startsWith(root + sep)) return undefined
  return resolved
}

/** `target` si c'est un fichier ; `target/index.html` si c'est un dossier qui en contient un ; sinon `undefined`. */
async function resolveServablePath(
  root: string,
  requestedPath: string,
): Promise<string | undefined> {
  const target = resolveWithinRoot(root, requestedPath)
  if (!target) return undefined
  try {
    const info = await stat(target)
    if (info.isFile()) return target
    if (info.isDirectory()) {
      const indexPath = join(target, 'index.html')
      const indexInfo = await stat(indexPath)
      return indexInfo.isFile() ? indexPath : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Sert `root` en statique sur un port éphémère. Le serveur écoute
 * exclusivement sur `127.0.0.1` — jamais `0.0.0.0` : cet aperçu porte le
 * code non revu d'un run en cours, il n'a aucune raison d'être joignable
 * depuis en dehors de la machine qui l'a lancé (le juge visuel, Playwright,
 * tourne dans le même process).
 */
export async function startStaticPreview(root: string): Promise<StaticPreview> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const filePath = await resolveServablePath(root, req.url ?? '/')
        if (!filePath) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Not found')
          return
        }
        const body = await readFile(filePath)
        const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
        res.writeHead(200, { 'content-type': type })
        res.end(body)
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Internal error')
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        // `server.close()` seul arrête l'ACCEPTATION de nouvelles connexions
        // mais attend que celles déjà ouvertes se terminent d'elles-mêmes
        // avant d'appeler son callback — une connexion keep-alive laissée
        // ouverte par Playwright pourrait donc faire pendre cette promesse
        // indéfiniment. `closeAllConnections` (Node 18.2+) les coupe de
        // force, ce qui garantit que `close()` se résout vite : c'est
        // précisément l'arrêt "toujours, y compris si quelque chose lève
        // entre-temps" que `deploying.ts` exige de ce module.
        server.closeAllConnections()
      }),
  }
}

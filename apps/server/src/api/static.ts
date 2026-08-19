import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'

/**
 * Sert le front construit, en production seulement.
 *
 * ## Pourquoi le serveur sert le front
 *
 * Un seul processus, un seul port : le VPS n'a pas besoin d'un nginx dont
 * l'unique rôle serait de servir trois fichiers statiques. En développement
 * rien de tout ceci ne tourne — Vite sert le front sur son propre port, avec
 * son rechargement à chaud.
 *
 * ## Pourquoi pas `@fastify/static`
 *
 * Règle dure de Florian : « une nouvelle dépendance, chaque bibliothèque est
 * de la maintenance et une surface d'attaque · tu proposes et tu justifies, tu
 * n'installes pas ». Servir un dossier de fichiers est cinquante lignes de
 * `node:fs`. Si le besoin grandit (plages d'octets, compression négociée,
 * ETags forts), `@fastify/static` reste la bonne réponse — mais pas pour ça.
 */

/** Types MIME des seules extensions que produit un build Vite. Inconnue ⇒ octet-stream. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
}

export interface StaticDeps {
  /** Racine du build (`apps/web/dist`). */
  root: string
}

/**
 * Résout un chemin d'URL en chemin de fichier DANS la racine, ou `null`.
 *
 * La traversée de répertoire est le seul vrai risque d'un serveur de fichiers
 * écrit à la main : `/../../../.env` ne doit jamais sortir de `dist/`. On
 * normalise puis on vérifie que le résultat commence bien par la racine
 * résolue — la comparaison inclut le séparateur, sinon `/dist-secret` passerait
 * pour un enfant de `/dist`.
 */
export function resolveInRoot(root: string, urlPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath)
    } catch {
      // Un pourcentage mal encodé n'est pas un chemin : on refuse.
      return null
    }
  })()
  if (decoded === null || decoded.includes('\0')) return null

  const rootResolved = resolve(root)
  const candidate = resolve(join(rootResolved, normalize(decoded)))
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) return null
  return candidate
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function registerStatic(app: FastifyInstance, deps: StaticDeps): Promise<void> {
  /**
   * Repli d'application monopage : toute route inconnue rend `index.html`,
   * c'est le routeur côté client qui décide. MAIS jamais sous `/api` — sinon
   * une faute de frappe dans une URL d'API répondrait 200 avec du HTML, et le
   * client planterait sur un JSON illisible au lieu de lire un 404 franc.
   */
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'route_inconnue' })
    }

    const filePath = resolveInRoot(deps.root, req.url.split('?')[0] ?? '/')
    if (filePath && (await isFile(filePath))) {
      const type = MIME[extname(filePath)] ?? 'application/octet-stream'
      // Les noms d'actifs produits par Vite portent une empreinte : ils sont
      // immuables. `index.html`, lui, ne doit jamais être mis en cache, sinon
      // un déploiement ne se voit pas.
      //
      // L'empreinte de Vite est en base64url (`index-Ck-JrNmN.css`), PAS en
      // hexadécimal : un motif `[0-9a-f]{8,}` ne la reconnaît pas, et tous les
      // actifs repartaient en `no-cache`. Constaté en démarrant réellement en
      // production, pas en relisant le code.
      const immutable = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(filePath)
      return reply
        .header('content-type', type)
        .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
        .send(createReadStream(filePath))
    }

    const index = join(resolve(deps.root), 'index.html')
    if (!(await isFile(index))) {
      // Dire ce qui manque plutôt que de rendre un 404 nu : sur un VPS, c'est
      // presque toujours un `pnpm build` oublié.
      return reply.code(503).send({
        error: 'front_absent',
        detail: `aucun index.html dans ${deps.root} · pnpm build ?`,
      })
    }
    return reply
      .header('content-type', MIME['.html'] as string)
      .header('cache-control', 'no-cache')
      .send(createReadStream(index))
  })
}

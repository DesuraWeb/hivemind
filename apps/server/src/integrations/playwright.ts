/**
 * Constat de vérification (Task 1, Phase 4) sur la façon dont le juge visuel
 * verra les captures — condition préalable à tout le reste de cette phase.
 *
 * Hypothèse du plan : l'outil `Read` du SDK lit les PNG et les présente
 * visuellement au modèle, donc le juge reçoit des chemins de fichiers et une
 * politique `fs: 'read'` sur le dossier d'artifacts, plutôt qu'un encodage
 * base64 dans le prompt.
 *
 * Vérifié en deux temps :
 *
 * 1. Types du SDK — `sdk-tools.d.ts` (paquet
 *    `@anthropic-ai/claude-agent-sdk@0.3.227`, résolu depuis `apps/server`) :
 *    `FileReadOutput` est une union `{ type: 'text'; file: {...} } | { type:
 *    'image'; file: { base64: string; type: 'image/png' | ...; originalSize;
 *    dimensions } } | ...`. Le tool_result que produit un appel `Read` sur un
 *    PNG est donc bien encodé en bloc image (base64 + MIME), pas en texte —
 *    c'est le SDK qui fait la conversion fichier → contenu visuel, l'appelant
 *    n'a jamais à le faire lui-même. Confirmé également par le champ
 *    `images?: { base64; mediaType }[]` sur `WorkflowOutput` (« Images
 *    returned by inner Read calls — surfaced as image content blocks »).
 *
 * 2. Essai réel (hors tests automatisés, car il consomme des tokens) : un
 *    agent lancé avec `tools: ['Read']` (aucun autre outil natif), un cwd
 *    contenant un PNG uni générés localement (rouge, puis bleu — deux
 *    couleurs, pour écarter une réponse par défaut), et un prompt qui ne
 *    contient QUE le nom de fichier (`sample.png`), jamais de base64 ni de
 *    description textuelle de l'image. Résultat : l'agent a appelé
 *    `Read({ file_path: 'sample.png' })` puis répondu correctement « Bleu. »
 *    et « Rouge. » selon le fichier — la seule façon d'obtenir cette réponse
 *    est d'avoir réellement vu le contenu visuel du fichier, le nom
 *    `sample.png` ne donnant aucun indice de couleur.
 *
 * Conclusion : la voie est validée, PAS `BLOCKED`. Le juge (Task 3) doit
 * recevoir des chemins de fichiers absolus vers les captures de ce module,
 * avec une session `{ bash: false, fs: 'read', mcp: [] }` dont le `cwd` est
 * le dossier d'artifacts du run — jamais de base64 injecté dans le prompt,
 * jamais de description textuelle du DOM comme substitut à la vision.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'

export type ViewportName = 'mobile' | 'tablette' | 'desktop'

interface ViewportSpec {
  name: ViewportName
  width: number
  height: number
}

/** Brief §10 : mobile 390, tablette 768, desktop 1440. Hauteurs choisies pour des appareils réels typiques. */
const VIEWPORTS: readonly ViewportSpec[] = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablette', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
]

export interface CapturedPage {
  /** Chemin de page tel que fourni en entrée (ex. `/`, `/about`). */
  page: string
  /** Dérivé de `page`, utilisé dans les noms de fichiers déterministes. */
  slug: string
  viewport: ViewportName
  width: number
  height: number
  /** Chemin absolu du PNG pleine page écrit sur disque. */
  screenshotPath: string
  /** Chemin absolu de l'extraction texte du DOM. */
  domPath: string
  domText: string
}

let browserSingleton: Promise<Browser> | undefined

/**
 * Un seul navigateur Chromium pour tout le process (brief §3 : « pool d'une
 * instance »). Lancement paresseux au premier appel : rien ne démarre tant
 * qu'aucune capture n'a été demandée. On met en cache la PROMESSE (pas
 * seulement le navigateur une fois résolu) pour qu'un deuxième appel arrivant
 * pendant le lancement du premier attende la même instance au lieu d'en
 * démarrer une deuxième.
 */
function getBrowser(): Promise<Browser> {
  if (!browserSingleton) {
    browserSingleton = chromium.launch({ headless: true })
  }
  return browserSingleton
}

/**
 * Ferme le navigateur partagé. À appeler une seule fois, à l'arrêt du
 * serveur (voir `src/index.ts`, à côté de `boss.stop()`). Une fuite de
 * Chromium coûte bien plus cher qu'une fuite de connexion Postgres :
 * contrairement au pool `pg`, rien ne récupère un process navigateur oublié.
 */
export async function closeBrowser(): Promise<void> {
  if (!browserSingleton) return
  const pending = browserSingleton
  browserSingleton = undefined
  const browser = await pending
  await browser.close()
}

/** `a-z0-9` et tirets simples — même politique que les slugs projet (`globes/repo.ts`). */
function slugifyPagePath(pagePath: string): string {
  const trimmed = pagePath.replace(/^\/+|\/+$/g, '')
  if (!trimmed) return 'index'
  const slug = trimmed
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'index'
}

/**
 * Capture chaque page de `paths` aux trois viewports (mobile 390, tablette
 * 768, desktop 1440) : un PNG pleine page et une extraction texte du DOM par
 * combinaison page × viewport, écrits dans `outDir`.
 *
 * Nommage déterministe (`<slug-page>-<viewport>.png` /
 * `.txt`) : un nom aléatoire rendrait la timeline d'audit illisible et
 * empêcherait le juge de référencer une capture de façon stable
 * (`screenshot_ref` du rapport du juge, Task 3).
 *
 * Une seule navigation par page : la page s'ouvre une fois, puis le viewport
 * est redimensionné pour chacune des 3 captures — le contenu responsive
 * s'adapte au resize, inutile de renaviguer trois fois.
 */
export async function capturePages(
  url: string,
  paths: string[],
  outDir: string,
): Promise<CapturedPage[]> {
  await mkdir(outDir, { recursive: true })
  const browser = await getBrowser()
  const results: CapturedPage[] = []

  for (const pagePath of paths) {
    const slug = slugifyPagePath(pagePath)
    const page: Page = await browser.newPage()
    try {
      const target = new URL(pagePath, url).toString()
      const response = await page.goto(target, { waitUntil: 'networkidle' })

      // Une page qui n'existe pas ne doit JAMAIS arriver au juge.
      //
      // Constaté sur un run réel : le garant avait rendu `public/index.html`
      // dans `pages_to_judge` alors que l'aperçu sert déjà `public/` comme
      // racine. Playwright a capturé le 404, le juge a honnêtement rapporté
      // « la capture ne montre pas » pour chaque critère — 0 conformité, 6
      // écarts dont un bloquant — et le garant, lui, a lu la source et conclu
      // « conforme ». Le bon verdict, rendu malgré un juge alimenté en
      // déchets : la panne était invisible.
      //
      // On échoue bruyamment plutôt que de produire une capture qui a l'air
      // valide. `status()` est absent pour les schémas non HTTP, d'où le test
      // sur la présence de la réponse.
      const status = response?.status()
      if (status !== undefined && status >= 400) {
        const rappel = 'sont relatifs à la RACINE SERVIE, pas au dépôt'
        throw new Error(
          `capture impossible : ${target} répond ${status}. Les chemins de pages_to_judge ${rappel}.`,
        )
      }

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        // Laisse le temps au CSS responsive de se stabiliser après le resize,
        // avant que la capture pleine page ne mesure la hauteur du document.
        await page.waitForTimeout(50)

        const screenshotPath = join(outDir, `${slug}-${viewport.name}.png`)
        await page.screenshot({ path: screenshotPath, fullPage: true })

        // Chaîne plutôt que fonction fléchée : le tsconfig serveur n'inclut
        // pas `lib: dom` (process Node pur), donc `document` n'existe pas
        // pour le compilateur ici — mais `page.evaluate` accepte une chaîne
        // de JS évaluée côté navigateur, où `document` existe bien.
        const domText = await page.evaluate<string>('document.body.innerText')
        const domPath = join(outDir, `${slug}-${viewport.name}.txt`)
        await writeFile(domPath, domText, 'utf8')

        results.push({
          page: pagePath,
          slug,
          viewport: viewport.name,
          width: viewport.width,
          height: viewport.height,
          screenshotPath,
          domPath,
          domText,
        })
      }
    } finally {
      // La page se ferme même si une capture a levé en cours de route — le
      // navigateur partagé, lui, n'est jamais fermé ici : il survit à
      // l'appel et sera réutilisé par la capture suivante.
      await page.close()
    }
  }

  return results
}

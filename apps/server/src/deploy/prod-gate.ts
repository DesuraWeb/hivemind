/**
 * Le gate de mise en production (Phase 5, Task 4).
 *
 * ## Pourquoi ce gate n'est pas une transition de la machine à états
 *
 * Le précédent le plus proche est `security/selfmod-gate.ts` : un item levé EN
 * PARALLÈLE du flux, par `inbox/repo.ts::createInboxItem`, sans ajouter le
 * moindre événement à `domain/run-state.ts`. On reprend ce mécanisme, pour des
 * raisons qui lui sont propres :
 *
 * - Une mise en prod ne fait pas partie de la vie d'un run. Le run se termine
 *   quand le step est validé ; la promotion en production est une décision qui
 *   lui SURVIT — Florian peut la prendre trois jours plus tard. En faire un
 *   état (`awaiting_prod`) obligerait le run à rester ouvert jusque-là : il
 *   tiendrait son worktree, garderait le step hors de `validated` et resterait
 *   dans la liste « en cours » sans que personne ne travaille dessus.
 * - Ce serait aussi changer le sens de `auto` dans `decide()`, donc redériver
 *   les 165 combinaisons de `tests/run-state.test.ts`, et ajouter une valeur à
 *   l'énumération `run_state` (migration) — pour une information que la
 *   machine n'a de toute façon pas : ni la PR, ni l'URL jugée, ni les fichiers
 *   modifiés ne lui sont accessibles, elle est volontairement pure.
 *
 * Là où ce gate DIFFÈRE de `selfmod-gate.ts` : son item n'est pas une `alert`
 * qui informe, c'est un `approval` qui porte une décision aux conséquences
 * réelles. Le mécanisme est le même, la sémantique non — d'où le type
 * `approval` et le sous-type `prod` du pack DA, pas un second sous-type
 * d'alerte.
 *
 * ## L'invariant que ce fichier protège
 *
 * Aucun chemin de code, nulle part, ne déploie en production. Le seul endroit
 * d'où une mise en prod pourra un jour partir est la résolution de cet item —
 * et cet item n'est jamais créé par la boucle elle-même, seulement par un
 * verdict `conforme` du garant, quel que soit le mode d'autonomie du step.
 * C'est ce qui rend le mode `auto` inoffensif ici : il porte sur l'itération
 * dev↔reviewer, jamais sur la prod.
 *
 * ## Ce qui n'est pas branché (Phase 5, Task 3)
 *
 * Il n'existe pas encore de cible de production, ni même de staging réel.
 * L'item le DIT (`prod.on_approve`) au lieu de laisser croire qu'un bouton
 * déploie quelque chose. Quand la Task 3 aboutira, c'est l'exécution qui
 * s'accrochera à un item déjà approuvé — pas le gate qui sera ajouté après
 * coup, ce qui laisserait une fenêtre où un run `auto` pourrait livrer.
 */

import { basename } from 'node:path'
import type { ApprovalSubtype, AutonomyMode } from '@silithid/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { type InboxItemRow, createInboxItem } from '../inbox/repo'

/** Sous-type de l'item levé par ce gate. Typé sur l'union partagée : un typo ne peut pas dériver du pack DA (`ap-215`, `sub: "prod"`). */
export const PROD_INBOX_SUBTYPE: ApprovalSubtype = 'prod'

/** Un fichier de la PR du step. Forme volontairement pauvre : ce que `integrations/github.ts` en sait, relu depuis le bus. */
export interface ProdChangedFile {
  path: string
  status: string | null
  additions: number | null
  deletions: number | null
}

/** L'état du dépôt d'avant ce step — la cible d'un retour arrière côté code. */
export interface ProdBase {
  /** Branche de base de la PR (`projects.default_branch`). */
  ref: string
  /** Commit sur lequel la base pointait quand le step a été cadré. */
  commit: string
}

/**
 * Par quoi on revient en arrière. `determined: false` n'est pas un échec du
 * gate : c'est l'information la plus utile qu'il puisse rendre ce jour-là.
 * Règle dure de Florian — « une migration sans rollback propre, ce n'est pas
 * fini » —, donc on préfère écrire « je ne sais pas revenir en arrière » dans
 * l'item plutôt que d'afficher une procédure qui ne défait rien.
 */
export type ProdRollback =
  | { determined: true; base: ProdBase; steps: string[] }
  | { determined: false; blockers: string[]; steps: string[] }

/**
 * L'URL sur laquelle le juge a réellement statué. `verified: false` couvre les
 * deux cas honnêtes d'aujourd'hui : aucune trace de déploiement, ou une URL
 * d'aperçu local déjà éteinte quand Florian lit l'item.
 */
export type ProdStaging =
  | { verified: true; url: string; targetKind: string; pages: number }
  | { verified: false; reason: string; declaredUrl: string | null }

/** Ce que le juge a relevé et que le garant a tout de même accepté. */
export interface ProdEcart {
  severite: string
  description: string
}

export interface RunProdGateOptions {
  runId: string
  projectId: string
  projectName: string
  step: { position: number; count: number; title: string }
  /**
   * Mode de boucle du step. Recopié dans l'item pour qu'on puisse VÉRIFIER
   * qu'un `auto` a bien levé le gate — il n'entre jamais dans la décision de
   * le lever, il n'y a d'ailleurs aucune condition dessus dans ce fichier.
   */
  autonomy: AutonomyMode
  iteration: number
  maxIterations: number
  /**
   * Le verdict qui ouvre la question. Typé sur le littéral `'conforme'` : un
   * verdict `ecarts` ne peut même pas être passé à ce gate — il n'y a rien à
   * promouvoir quand le garant vient de refuser le step, et un item de prod
   * levé sur un refus n'apprendrait rien tout en usant l'attention qu'on veut
   * garder intacte pour les vrais.
   */
  verdict: { decision: 'conforme'; ecarts: ProdEcart[] }
  pr: { number: number; url: string } | null
  changedFiles: ProdChangedFile[]
  base: ProdBase | null
  staging: ProdStaging
}

/**
 * Configuration serveur d'un client. Règle dure de Florian : Silithid n'écrit
 * JAMAIS dedans — ni pendant un run, ni au déploiement. Ce gate ne peut rien
 * écrire (il n'écrit qu'un item d'inbox), mais il peut voir qu'un step en
 * dépend et le dire : une PR qui embarque un `.htaccess` produira une prod qui
 * ne se comporte pas comme le staging, et personne ne comprendra pourquoi.
 */
function isServerConfig(path: string): boolean {
  const lower = path.toLowerCase()
  const name = basename(lower)
  if (name === '.htaccess' || name === '.user.ini' || name === 'php.ini') return true
  if (name === 'web.config' || name === 'nginx.conf' || lower.endsWith('.nginx')) return true
  if (name === 'crontab' || name === 'crontab.txt') return true
  const segments = lower.split('/')
  return segments.includes('nginx') || segments.includes('cron.d')
}

/**
 * Détection volontairement large. L'asymétrie est assumée : un faux positif
 * coûte une phrase de plus dans l'item (« vérifiez le retour arrière du
 * schéma »), un faux négatif ferait afficher un rollback propre là où le
 * schéma serait, lui, déjà parti sans retour.
 */
function isMigration(path: string): boolean {
  const lower = path.toLowerCase()
  if (lower.endsWith('.sql')) return true
  const segments = lower.split('/')
  return segments.includes('migrations') || segments.includes('migrate')
}

/** Relit une liste de fichiers depuis `messages.meta` (JSON non typé), en jetant tout ce qui n'a pas la bonne forme. */
export function parseChangedFiles(raw: unknown): ProdChangedFile[] {
  if (!Array.isArray(raw)) return []
  const files: ProdChangedFile[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as { path?: unknown; status?: unknown }
    if (typeof candidate.path !== 'string') continue
    const numbers = entry as { additions?: unknown; deletions?: unknown }
    files.push({
      path: candidate.path,
      status: typeof candidate.status === 'string' ? candidate.status : null,
      additions: typeof numbers.additions === 'number' ? numbers.additions : null,
      deletions: typeof numbers.deletions === 'number' ? numbers.deletions : null,
    })
  }
  return files
}

const LOOPBACK_URL = /^https?:\/\/(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i

/**
 * Ce que vaut l'URL que le juge a capturée.
 *
 * Le test porte sur l'URL, pas sur le nom de la cible (`target.kind`) : c'est
 * l'URL que Florian va cliquer, et une future implémentation de `DeployTarget`
 * portant un autre nom passerait sans bruit à travers un test par nom. Une
 * adresse de bouclage n'est joignable que depuis la machine du serveur, et
 * l'aperçu local est de toute façon relâché à la fin de `deploying.ts` : la
 * présenter comme « URL de staging vérifiée » serait un mensonge d'interface.
 */
export function resolveStaging(
  deployed: { url: string; targetKind: string; pages: number } | null,
  declaredUrl: string | null,
): ProdStaging {
  if (!deployed) {
    return {
      verified: false,
      reason:
        "Aucune trace de déploiement dans la timeline de ce run : aucune URL n'a été vérifiée.",
      declaredUrl,
    }
  }
  if (LOOPBACK_URL.test(deployed.url)) {
    return {
      verified: false,
      reason: `Le juge a statué sur un aperçu local éphémère (${deployed.url}, cible « ${deployed.targetKind} »), arrêté dès la fin de la capture : cette adresse n'est plus ouvrable. Le staging réel n'est pas encore branché (Phase 5, Task 3).`,
      declaredUrl,
    }
  }
  return {
    verified: true,
    url: deployed.url,
    targetKind: deployed.targetKind,
    pages: deployed.pages,
  }
}

/** Le retour arrière, calculé à partir de ce que le run a réellement enregistré — jamais supposé. */
export function buildRollback(opts: {
  base: ProdBase | null
  pr: { number: number; url: string } | null
  changedFiles: ProdChangedFile[]
}): ProdRollback {
  const base = opts.base
  const migrations = opts.changedFiles.filter((f) => isMigration(f.path))

  const codeSteps: string[] = []
  if (opts.pr) {
    codeSteps.push(
      `Annuler la PR #${opts.pr.number} depuis GitHub (bouton « Revert ») · aucune commande à taper : ${opts.pr.url}`,
    )
  }
  if (base) {
    codeSteps.push(
      `Le dépôt revient alors au commit ${base.commit} de ${base.ref} · l'état exact d'avant ce step.`,
    )
  }

  const blockers: string[] = []
  if (!base) {
    blockers.push(
      "La base de ce step n'a pas été enregistrée par le run : impossible d'affirmer sur quel commit " +
        'la production reviendrait. À déterminer à la main avant de valider.',
    )
  }
  if (migrations.length > 0) {
    const paths = migrations.map((f) => f.path).join(', ')
    blockers.push(
      `${migrations.length} fichier(s) de migration dans ce step (${paths}) · annuler le code ne défait pas un schéma déjà migré. Le retour arrière du schéma n'est pas déductible d'ici : il doit être vérifié à la main avant de valider.`,
    )
  }

  // `base` absent est déjà un bloquant ci-dessus : la garde ici n'est là que
  // pour que le compilateur le sache, elle n'ajoute aucune règle.
  if (base && blockers.length === 0) return { determined: true, base, steps: codeSteps }
  return { determined: false, blockers, steps: codeSteps }
}

function buildTitle(projectName: string, position: number): string {
  // Forme du pack DA (`ap-215`) : « Mise en prod · Le Koin, step 3 ».
  return `Mise en prod · ${projectName}, step ${position}`
}

/** « Step 3/7 · Fiche établissement » — la ligne de tête du panneau prod du pack DA. */
function formatStep(step: { position: number; count: number; title: string }): string {
  return `Step ${step.position}/${step.count} · ${step.title}`
}

function formatIters(iteration: number, maxIterations: number, ecarts: number): string {
  const suffix = ecarts === 0 ? 'aucun écart relevé' : `${ecarts} écart(s) relevé(s) par le juge`
  return `${iteration} itération(s) sur ${maxIterations} · ${suffix}`
}

function formatVerdict(ecarts: ProdEcart[]): string {
  const blocking = ecarts.filter((e) => e.severite === 'bloquant').length
  if (ecarts.length === 0) return 'conforme · aucun écart'
  return `conforme · ${ecarts.length} écart(s) accepté(s) en l'état, ${blocking} bloquant(s)`
}

/** « PR #142 · +2 340 −118 · 14 fichiers ». Les compteurs manquent si le bus ne les portait pas : on n'invente pas de chiffre. */
function formatPr(pr: { number: number } | null, files: ProdChangedFile[]): string {
  if (!pr) return 'Aucune pull request enregistrée pour ce run'
  const counted = files.filter((f) => f.additions !== null && f.deletions !== null)
  const parts = [`PR #${pr.number}`]
  if (counted.length > 0) {
    const additions = counted.reduce((sum, f) => sum + (f.additions ?? 0), 0)
    const deletions = counted.reduce((sum, f) => sum + (f.deletions ?? 0), 0)
    parts.push(`+${additions} −${deletions}`)
  }
  parts.push(`${files.length} fichier(s)`)
  return parts.join(' · ')
}

/** Au-delà, la liste cesse d'aider à décider et devient un mur. Le compte exact reste dans `prod.pr`. */
const MAX_LISTED_FILES = 25

function formatChanges(files: ProdChangedFile[]): string[] {
  if (files.length === 0) return ['(aucun fichier listé pour ce run · voir le diff de la PR)']
  const listed = files.slice(0, MAX_LISTED_FILES).map((f) => {
    const counts =
      f.additions !== null && f.deletions !== null ? ` (+${f.additions} −${f.deletions})` : ''
    return `${f.status ?? 'modified'} · ${f.path}${counts}`
  })
  if (files.length > MAX_LISTED_FILES) {
    listed.push(`… et ${files.length - MAX_LISTED_FILES} autre(s) fichier(s)`)
  }
  return listed
}

function buildWarnings(files: ProdChangedFile[]): string[] {
  const serverConfig = files.filter((f) => isServerConfig(f.path))
  if (serverConfig.length === 0) return []
  const paths = serverConfig.map((f) => f.path).join(', ')
  return [
    `Ce step touche ${serverConfig.length} fichier(s) de configuration serveur (${paths}) · Silithid ne les déploie jamais, règle dure. Si le step en dépend, la modification doit être appliquée à la main sur le serveur, sinon la production ne se comportera pas comme le staging.`,
  ]
}

/**
 * Ce qui se passe réellement quand Florian valide. Aujourd'hui : rien
 * d'automatique. Le dire est le seul moyen de ne pas transformer un item
 * honnête en bouton menteur.
 */
const ON_APPROVE_NO_TARGET =
  "Valider cet item ne déclenche aucun déploiement : Silithid n'a pas encore de cible de production " +
  '(Phase 5, Task 3, en attente des accès). La mise en ligne reste manuelle · cet item en est la trace ' +
  'de décision, et le seul endroit depuis lequel un déploiement pourra un jour partir.'

function buildCtx(opts: RunProdGateOptions): string {
  return (
    `verdict conforme du garant en itération ${opts.iteration}/${opts.maxIterations} · ` +
    `mode de boucle « ${opts.autonomy} » · aucun déploiement déclenché par cet item`
  )
}

/**
 * Lève le gate de mise en prod.
 *
 * Appelé par `loop/steps/verdict.ts` sur un verdict `conforme`, AVANT que
 * l'événement ne parte vers `decide()`. Aucune condition sur `autonomy` : un
 * step en `auto` lève ce gate exactement comme un step en `gated` — c'est la
 * règle centrale de la Task 4, et elle est vérifiée par
 * `tests/gate-prod.test.ts` sur le handler réel, pas sur cette fonction seule.
 *
 * Dédoublonné comme `selfmod-gate.ts` : un run peut repasser par `verdict`
 * après un `awaiting_human` résolu, et une seconde question identique en
 * inbox n'apporterait rien.
 */
export async function runProdGate(
  db: Kysely<Database>,
  opts: RunProdGateOptions,
): Promise<InboxItemRow | undefined> {
  const existing = await db
    .selectFrom('inbox_items')
    .select('id')
    .where('run_id', '=', opts.runId)
    .where('type', '=', 'approval')
    .where('subtype', '=', PROD_INBOX_SUBTYPE)
    .where('status', '=', 'open')
    .executeTakeFirst()
  if (existing) return undefined

  const rollback = buildRollback({
    base: opts.base,
    pr: opts.pr,
    changedFiles: opts.changedFiles,
  })
  const title = buildTitle(opts.projectName, opts.step.position)

  return createInboxItem(db, {
    type: 'approval',
    subtype: PROD_INBOX_SUBTYPE,
    projectId: opts.projectId,
    runId: opts.runId,
    // Le garant, pas 'system' : c'est son verdict conforme qui ouvre la
    // question, et l'UI affiche ce rôle à côté du titre.
    fromRole: 'garant',
    title,
    payload: {
      cause: title,
      ctx: buildCtx(opts),
      autonomy: opts.autonomy,
      prod: {
        // Les quatre clés du panneau prod du pack DA (`Inbox.dc.html`), aux
        // mêmes noms — le reste s'y ajoute sans rien casser.
        step: formatStep(opts.step),
        iters: formatIters(opts.iteration, opts.maxIterations, opts.verdict.ecarts.length),
        verdict: formatVerdict(opts.verdict.ecarts),
        pr: formatPr(opts.pr, opts.changedFiles),
        changes: formatChanges(opts.changedFiles),
        ecarts: opts.verdict.ecarts,
        staging: opts.staging,
        rollback,
        // Relues telles quelles par le job de déploiement, jamais recalculées :
        // ce qui part en prod doit être exactement ce qui a été MONTRÉ ici.
        migrations: opts.changedFiles.filter((f) => isMigration(f.path)).map((f) => f.path),
        warnings: buildWarnings(opts.changedFiles),
        on_approve: ON_APPROVE_NO_TARGET,
      },
      pr_number: opts.pr?.number ?? null,
      pr_url: opts.pr?.url ?? null,
    },
  })
}

/**
 * DÉCISION SUR LES `screenshot_ref` INVENTÉS (Task 3, Phase 4) — le plan
 * exige de trancher ce point et de le justifier ici.
 *
 * `judgeReportSchema` (`../../runtime/structured.ts`) ne peut PAS valider
 * qu'une `screenshot_ref` correspond à un artifact réellement enregistré :
 * zod ne connaît que la forme (une chaîne non vide), jamais le contenu de la
 * table `artifacts`. Cette validation est donc faite ICI, après coup, contre
 * `listRunArtifacts(db, runId)`.
 *
 * Le choix retenu est le REJET ET RETRY, jamais le nettoyage silencieux :
 * un juge qui invente une référence a soit halluciné une capture qu'il n'a
 * pas regardée, soit mal recopié le nom d'un fichier qu'il a bien lu — dans
 * les deux cas, laisser passer l'écart avec une référence morte produirait
 * un rapport que l'UI ne peut pas illustrer (capture manquante) et que le
 * garant (Task 4) ne peut pas vérifier lui-même. Nettoyer silencieusement
 * (retirer juste le `screenshot_ref`, ou l'écart entier) ferait disparaître
 * un signal potentiellement réel sans que personne ne le sache. On retente
 * donc, sur la même session — le juge a déjà vu les captures, on lui rappelle
 * juste la liste exacte des références valables — borné à
 * `MAX_REF_ATTEMPTS`, avec le même style que `collectStructured` : au-delà,
 * une erreur explicite plutôt qu'un rapport dégradé accepté en silence.
 * Cette erreur fait échouer le job `run.step` (comme un throw de
 * `coding.ts`/`reviewing.ts` sur une anomalie d'infra) : elle est retryable
 * par pg-boss, elle ne fabrique pas d'événement `judge_report` invalide pour
 * la machine à états.
 */

import { basename, join } from 'node:path'
import type { ArtifactRecord } from '../../artifacts/store'
import { listRunArtifacts } from '../../artifacts/store'
import type { LoopEvent } from '../../domain/run-state'
import type { StepHandler } from '../../jobs/run-step'
import { type JudgeReport, collectStructured, judgeReportSchema } from '../../runtime/structured'
import type { AgentSession, RuntimeAdapter } from '../../runtime/types'
import { type StoredMessage, appendMessage, readRunMessages } from '../bus'
import { resolveProjectRole } from '../roles'

export interface JudgingDeps {
  adapter: RuntimeAdapter
  /** Racine de stockage des captures (`ARTIFACTS_ROOT`), même convention que `deploying.ts`/`capture.test.ts`. */
  artifactsRoot: string
}

/** Borne dure des tentatives de correction d'une `screenshot_ref` inventée — voir le commentaire de tête. */
const MAX_REF_ATTEMPTS = 2

interface CaptureEntry {
  page: string
  viewport: string
  /** Nom de fichier tel qu'il existe dans le cwd de la session juge — c'est l'identifiant attendu en `screenshot_ref`. */
  screenshotRef: string
  domRef?: string
}

/** Le cadrage garant→dev le plus récent (même passation que `reviewing.ts`/`coding.ts` lisent). */
function findFrame(
  messages: StoredMessage[],
): { body: string; acceptanceCriteria: string[] } | undefined {
  const frameMessage = [...messages]
    .reverse()
    .find((m) => m.kind === 'prompt' && m.fromRole === 'garant' && m.toRole === 'dev')
  if (!frameMessage) return undefined

  const rawCriteria = frameMessage.meta.acceptance_criteria
  const acceptanceCriteria = Array.isArray(rawCriteria)
    ? rawCriteria.filter((c): c is string => typeof c === 'string')
    : []
  return { body: frameMessage.body, acceptanceCriteria }
}

/**
 * Regroupe les artifacts `screenshot`/`dom_snapshot` de ce run par (page,
 * viewport) — même clé que `recordCapturedPages` écrit dans `meta`
 * (`../../artifacts/store.ts`). Le nom de fichier (`basename`), pas le chemin
 * relatif à `ARTIFACTS_ROOT` (qui inclut `<runId>/`) : c'est ce nom que le
 * juge voit réellement dans son cwd (le dossier d'artifacts du run), donc
 * c'est ce qu'il doit citer en `screenshot_ref`.
 */
function groupCaptures(artifacts: ArtifactRecord[]): CaptureEntry[] {
  const screenshots = artifacts.filter((a) => a.kind === 'screenshot')
  const doms = artifacts.filter((a) => a.kind === 'dom_snapshot')

  return screenshots.map((shot) => {
    const page = typeof shot.meta.page === 'string' ? shot.meta.page : '(page inconnue)'
    const viewport =
      typeof shot.meta.viewport === 'string' ? shot.meta.viewport : '(viewport inconnu)'
    const dom = doms.find(
      (d) => d.meta.page === shot.meta.page && d.meta.viewport === shot.meta.viewport,
    )
    return {
      page,
      viewport,
      screenshotRef: basename(shot.path),
      ...(dom ? { domRef: basename(dom.path) } : {}),
    }
  })
}

function buildCaptureList(entries: CaptureEntry[]): string {
  return entries
    .map(
      (e) =>
        `- page "${e.page}", viewport ${e.viewport} : capture = ${e.screenshotRef}${e.domRef ? `, extraction DOM = ${e.domRef}` : ''}`,
    )
    .join('\n')
}

function buildPreamble(opts: {
  projectName: string
  devPrompt: string
  acceptanceCriteria: string[]
  captures: CaptureEntry[]
}): string {
  return [
    '# Jugement visuel',
    `Projet : ${opts.projectName}`,
    '',
    '# Cadrage initial du garant',
    opts.devPrompt,
    '',
    "# Critères d'acceptation",
    ...(opts.acceptanceCriteria.length > 0
      ? opts.acceptanceCriteria.map((c) => `- ${c}`)
      : ['(aucun critère explicite)']),
    '',
    '# Captures disponibles (fichiers dans ton dossier de travail actuel)',
    buildCaptureList(opts.captures),
    '',
    "Utilise l'outil Read pour ouvrir chaque capture (PNG) et, si utile, chaque " +
      'extraction DOM (texte) avant de juger — ne devine jamais le contenu ' +
      "d'une capture que tu n'as pas ouverte.",
    '',
    'Le champ "screenshot_ref" de chaque écart doit être EXACTEMENT le nom de ' +
      'fichier de la capture listée ci-dessus (ex. `index-mobile.png`), jamais ' +
      'une référence inventée ou reformulée. Rends ton rapport en appelant ' +
      "l'outil de sortie structurée mis à ta disposition.",
  ].join('\n')
}

function buildRefRetryPrompt(invalidRefs: string[], validRefs: readonly string[]): string {
  return [
    `Ta réponse précédente référence une capture qui n'existe pas : ${invalidRefs.join(', ')}.`,
    `Les seules références valides sont : ${validRefs.join(', ')}.`,
    'Corrige le(s) champ(s) "screenshot_ref" concerné(s) — en te basant sur une ' +
      'capture que tu as réellement ouverte avec Read — et renvoie un rapport ' +
      "complet en rappelant l'outil de sortie structurée.",
  ].join('\n')
}

/** Distingue les références inventées de celles réellement enregistrées, sans doublon. */
function findInvalidRefs(report: JudgeReport, validRefs: ReadonlySet<string>): string[] {
  const invalid = report.ecarts.map((e) => e.screenshot_ref).filter((ref) => !validRefs.has(ref))
  return [...new Set(invalid)]
}

/**
 * Obtient un rapport dont CHAQUE `screenshot_ref` correspond à un artifact
 * réellement enregistré (voir la décision en tête de fichier). `collectStructured`
 * garantit déjà la forme (Task 7) ; cette boucle ajoute la garantie de fond
 * que `judgeReportSchema` ne peut pas exprimer en zod seul.
 */
async function collectValidatedJudgeReport(
  adapter: RuntimeAdapter,
  session: AgentSession,
  prompt: string,
  validRefs: ReadonlySet<string>,
): Promise<JudgeReport> {
  let currentPrompt = prompt
  let lastInvalid: string[] = []

  for (let attempt = 1; attempt <= MAX_REF_ATTEMPTS; attempt++) {
    const report = await collectStructured(adapter, session, currentPrompt, judgeReportSchema, {
      toolName: 'submit_judge_report',
      toolDescription:
        'Soumet le rapport du juge visuel : conformités et écarts constatés, sans décision.',
    })

    const invalidRefs = findInvalidRefs(report, validRefs)
    if (invalidRefs.length === 0) return report

    lastInvalid = invalidRefs
    currentPrompt = buildRefRetryPrompt(invalidRefs, [...validRefs])
  }

  throw new Error(
    `run juge : screenshot_ref inventé(s) après ${MAX_REF_ATTEMPTS} tentative(s) : ` +
      `${lastInvalid.join(', ')} — aucun artifact "screenshot" correspondant en base`,
  )
}

function formatJudgeReport(report: JudgeReport): string {
  const lines = [
    `${report.conformites.length} conformité(s) constatée(s), ${report.ecarts.length} écart(s).`,
  ]
  if (report.conformites.length > 0) {
    lines.push('', 'Conformités :', ...report.conformites.map((c) => `- ${c}`))
  }
  if (report.ecarts.length > 0) {
    lines.push(
      '',
      'Écarts :',
      ...report.ecarts.map(
        (e) =>
          `- [${e.severite}] ${e.page} (${e.viewport}) — ${e.description} (réf. ${e.screenshot_ref})`,
      ),
    )
  }
  return lines.join('\n')
}

/**
 * Handler réel de l'état `judging` (Task 3, Phase 4). Aucun serveur à
 * démarrer : `deploying.ts` (Task 2) a déjà capturé et enregistré les
 * artifacts avant d'émettre `ci_green` — ce handler relit seulement ce qui
 * est sur disque.
 *
 * Session à surface minimale (`{ bash: false, fs: 'read', mcp: [] }`), `cwd`
 * posé sur le dossier d'artifacts du run (`<artifactsRoot>/<runId>`, même
 * convention que `deploying.ts`) : c'est la voie validée par Task 1
 * (`../../integrations/playwright.ts`, commentaire de tête) pour que le juge
 * voie réellement les captures via l'outil `Read`, jamais du base64 injecté
 * dans le prompt.
 */
export function createJudgingHandler(deps: JudgingDeps): StepHandler {
  return async (db, runId) => {
    const runRow = await db
      .selectFrom('runs')
      .innerJoin('steps', 'steps.id', 'runs.step_id')
      .innerJoin('projects', 'projects.id', 'steps.project_id')
      .select([
        'steps.project_id as projectId',
        'projects.name as projectName',
        'projects.juge_visuel as jugeVisuel',
      ])
      .where('runs.id', '=', runId)
      .executeTakeFirstOrThrow()

    // Juge désactivé : `deploying` n'a rien capturé, il n'y a rien à regarder.
    // On écrit quand même la passation juge→garant, parce que `verdict.ts`
    // l'exige et surtout parce que le garant doit savoir sur quoi il tranche.
    // Un rapport vide qui ne dirait pas POURQUOI il est vide laisserait croire
    // à un juge qui n'a rien trouvé — ce n'est pas la même chose qu'un juge
    // qui n'a pas regardé.
    if (!runRow.jugeVisuel) {
      await appendMessage(db, {
        runId,
        fromRole: 'judge',
        toRole: 'garant',
        kind: 'report',
        body:
          'Aucun contrôle visuel sur ce projet · le juge est désactivé (`projects.juge_visuel`). ' +
          "Rien n'a été déployé ni capturé. Tranche depuis le cadrage et le rapport du reviewer " +
          'seuls, et ne conclus rien sur le rendu : personne ne l’a regardé.',
        meta: { juge_visuel: false, conformites: [], ecarts: [] },
      })
      return { type: 'judge_report' } satisfies LoopEvent
    }

    const messages = await readRunMessages(db, runId)
    const frame = findFrame(messages)
    if (!frame) {
      throw new Error(`run ${runId} : aucun cadrage garant→dev trouvé dans le bus (état judging)`)
    }

    const artifacts = await listRunArtifacts(db, runId)
    const captures = groupCaptures(artifacts)
    if (captures.length === 0) {
      throw new Error(
        `run ${runId} : aucune capture (kind "screenshot") enregistrée en base — deploying.ts a-t-il bien émis ci_green après avoir capturé ? (état judging)`,
      )
    }
    const validRefs = new Set(captures.map((c) => c.screenshotRef))

    const role = await resolveProjectRole(db, runRow.projectId, 'judge')
    const artifactsDir = join(deps.artifactsRoot, runId)

    const session = await deps.adapter.createSession({
      roleKey: 'judge',
      systemPrompt: role.systemPrompt,
      cwd: artifactsDir,
      tools: { bash: false, fs: 'read', mcp: [] },
      onEvent: () => {},
    })

    const preamble = buildPreamble({
      projectName: runRow.projectName,
      devPrompt: frame.body,
      acceptanceCriteria: frame.acceptanceCriteria,
      captures,
    })

    const report = await collectValidatedJudgeReport(deps.adapter, session, preamble, validRefs)

    // Passation juge→garant : c'est lui qui tranche depuis ce constat (Task 4).
    await appendMessage(db, {
      runId,
      fromRole: 'judge',
      toRole: 'garant',
      kind: 'report',
      body: formatJudgeReport(report),
      meta: { conformites: report.conformites, ecarts: report.ecarts },
    })

    return { type: 'judge_report' } satisfies LoopEvent
  }
}

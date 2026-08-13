import { isAbsolute, join, relative, sep } from 'node:path'
import type { Kysely, Selectable } from 'kysely'
import type { ArtifactsTable, Database } from '../db/types'
import type { CapturedPage } from '../integrations/playwright'

export type ArtifactKind = 'screenshot' | 'dom_snapshot' | 'judge_report' | 'diff'

export interface ArtifactRecord {
  id: string
  runId: string | null
  kind: string
  /** Relatif à `ARTIFACTS_ROOT` — jamais un chemin absolu de la machine de dev (voir `toRelativeArtifactPath`). */
  path: string
  meta: Record<string, unknown>
  createdAt: Date
}

/**
 * Convertit le chemin absolu réellement écrit sur disque en chemin relatif à
 * `artifactsRoot`. Un chemin absolu de cette machine n'aurait aucun sens
 * après la bascule VPS (brief) : on refuse d'enregistrer autre chose qu'un
 * chemin qui résout depuis la racine des artifacts, avec une vérification
 * explicite plutôt qu'une confiance aveugle dans l'appelant.
 */
function toRelativeArtifactPath(artifactsRoot: string, absolutePath: string): string {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`recordArtifact attend un chemin absolu en entrée, reçu : ${absolutePath}`)
  }
  const rel = relative(artifactsRoot, absolutePath)
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Le fichier ${absolutePath} est hors de ARTIFACTS_ROOT (${artifactsRoot})`)
  }
  return rel
}

export interface RecordArtifactInput {
  runId: string
  kind: ArtifactKind | string
  /** Chemin absolu réel du fichier sur disque — converti en relatif avant insertion. */
  absolutePath: string
  artifactsRoot: string
  meta?: Record<string, unknown>
}

function toArtifactRecord(row: Selectable<ArtifactsTable>): ArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    path: row.path,
    meta: row.meta as Record<string, unknown>,
    // `Timestamp` est un ColumnType : à la lecture le driver rend un Date,
    // mais le type déclaré couvre aussi les formes acceptées à l'écriture.
    createdAt: new Date(row.created_at as unknown as string),
  }
}

/** Enregistre un artifact déjà écrit sur disque. Le chemin stocké en DB est relatif à `artifactsRoot`, jamais absolu. */
export async function recordArtifact(
  db: Kysely<Database>,
  input: RecordArtifactInput,
): Promise<ArtifactRecord> {
  const path = toRelativeArtifactPath(input.artifactsRoot, input.absolutePath)
  const row = await db
    .insertInto('artifacts')
    .values({
      run_id: input.runId,
      kind: input.kind,
      path,
      meta: JSON.stringify(input.meta ?? {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return toArtifactRecord(row)
}

/**
 * Convenance : enregistre en une passe le PNG (`kind: 'screenshot'`) et
 * l'extraction DOM (`kind: 'dom_snapshot'`) de chaque `CapturedPage` produite
 * par `capturePages` (`../integrations/playwright.ts`).
 */
export async function recordCapturedPages(
  db: Kysely<Database>,
  runId: string,
  artifactsRoot: string,
  captures: readonly CapturedPage[],
): Promise<ArtifactRecord[]> {
  const records: ArtifactRecord[] = []
  for (const capture of captures) {
    const meta = {
      page: capture.page,
      viewport: capture.viewport,
      width: capture.width,
      height: capture.height,
    }
    records.push(
      await recordArtifact(db, {
        runId,
        kind: 'screenshot',
        absolutePath: capture.screenshotPath,
        artifactsRoot,
        meta,
      }),
    )
    records.push(
      await recordArtifact(db, {
        runId,
        kind: 'dom_snapshot',
        absolutePath: capture.domPath,
        artifactsRoot,
        meta,
      }),
    )
  }
  return records
}

/**
 * Timeline des artifacts d'un run, du plus ancien au plus récent — le juge
 * (Task 3) et l'audit de la boucle s'appuient dessus.
 */
export async function listRunArtifacts(
  db: Kysely<Database>,
  runId: string,
): Promise<ArtifactRecord[]> {
  const rows = await db
    .selectFrom('artifacts')
    .selectAll()
    .where('run_id', '=', runId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute()

  return rows.map(toArtifactRecord)
}

/** Résout un `ArtifactRecord.path` (relatif à `ARTIFACTS_ROOT`) en chemin absolu réel sur disque. */
export function resolveArtifactPath(
  artifactsRoot: string,
  record: Pick<ArtifactRecord, 'path'>,
): string {
  return join(artifactsRoot, record.path)
}

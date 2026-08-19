import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { createInboxItem } from '../inbox/repo'
import type { StoredMessage } from './bus'

/**
 * Le garant contredit-il le juge sur TOUT ?
 *
 * ## Pourquoi ce garde-fou existe
 *
 * Constaté sur une vraie boucle, le 15/08 : le juge a rendu « 0 conformité,
 * 6 écarts dont un bloquant », et le garant a répondu « conforme ». Le garant
 * avait raison — il avait lu la source, le lien existait bien. Le juge, lui,
 * avait capturé un 404 : `pages_to_judge` portait un chemin de dépôt au lieu
 * d'un chemin d'URL.
 *
 * **Le bon verdict, rendu malgré un juge nourri de déchets.** La panne était
 * invisible, et le serait restée indéfiniment : rien dans le résultat ne
 * distingue « le juge s'est trompé et le garant a rattrapé » de « tout va
 * bien ».
 *
 * La cause connue est corrigée (`integrations/playwright.ts` échoue sur une
 * réponse ≥ 400). Ce garde-fou traite la CLASSE : quelle que soit la raison,
 * un juge qui ne voit rien de correct pendant que le garant valide est un
 * signal, pas un détail.
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne change pas le verdict. Le garant reste l'arbitre — c'est son rôle
 * d'aller lire la source quand une capture ne suffit pas, et le lui retirer
 * ferait perdre ce qui marche. L'item est levé EN PARALLÈLE, comme le 4ᵉ gate.
 *
 * ## Le seuil, et pourquoi celui-là
 *
 * Zéro conformité ET au moins un écart bloquant. Pas « le garant a écarté un
 * point » — ça, c'est de l'arbitrage normal et quotidien. Ici le juge n'a
 * validé AUCUN critère et a bloqué, et on passe outre en totalité : soit il
 * n'a rien vu, soit il regardait autre chose. Dans les deux cas, la prochaine
 * capture mérite un œil.
 */

export const JUDGE_BLIND_SUBTYPE = 'judge_contradiction'

export interface JudgeSummary {
  conformites: number
  ecartsBloquants: number
  total: number
}

/** Lit le rapport structuré du juge depuis `meta` (écrit par `judging.ts`). */
export function readJudgeSummary(messages: StoredMessage[]): JudgeSummary | null {
  const report = [...messages]
    .reverse()
    .find((m) => m.kind === 'report' && m.fromRole === 'judge' && m.toRole === 'garant')
  if (!report) return null

  const conformites = report.meta.conformites
  const ecarts = report.meta.ecarts
  // Un rapport sans ces clés vient d'avant la Phase 4 : on ne devine pas.
  if (!Array.isArray(conformites) || !Array.isArray(ecarts)) return null

  const bloquants = ecarts.filter(
    (e): e is { severite: string } =>
      typeof e === 'object' && e !== null && (e as { severite?: unknown }).severite === 'bloquant',
  ).length

  return { conformites: conformites.length, ecartsBloquants: bloquants, total: ecarts.length }
}

/** Vrai quand le garant valide un travail que le juge n'a validé en rien. */
export function contredit(resume: JudgeSummary | null, decision: string): boolean {
  if (!resume) return false
  return decision === 'conforme' && resume.conformites === 0 && resume.ecartsBloquants > 0
}

export interface RaiseOpts {
  runId: string
  projectId: string
  resume: JudgeSummary
}

export async function raiseJudgeContradiction(
  db: Kysely<Database>,
  opts: RaiseOpts,
): Promise<void> {
  // Dédoublonné par run : une itération corrective qui reproduirait le motif
  // n'ajoute pas un second item, elle confirme le premier.
  const existant = await db
    .selectFrom('inbox_items')
    .select('id')
    .where('run_id', '=', opts.runId)
    .where('subtype', '=', JUDGE_BLIND_SUBTYPE)
    .where('status', '=', 'open')
    .executeTakeFirst()
  if (existant) return

  await createInboxItem(db, {
    type: 'alert',
    subtype: JUDGE_BLIND_SUBTYPE,
    projectId: opts.projectId,
    runId: opts.runId,
    fromRole: 'system',
    title: `Le juge visuel n'a validé aucun critère · le garant a quand même conclu « conforme »`,
    payload: {
      cause: 'judge.aucune_conformite',
      ctx: [
        `Le juge a rendu ${opts.resume.conformites} conformité(s) et ${opts.resume.total} écart(s), dont ${opts.resume.ecartsBloquants} bloquant(s). Le garant a conclu « conforme ».`,
        '',
        "Le verdict n'est pas remis en cause : le garant arbitre, et il lui arrive légitimement d'aller lire la source quand une capture ne suffit pas.",
        '',
        "Ce qui mérite un œil, c'est le juge : ne rien valider du tout et bloquer, alors que le travail est conforme, veut dire qu'il n'a pas vu ce qu'il devait voir. Vérifiez les captures de ce run — une page capturée en erreur produit exactement ce motif.",
      ].join('\n'),
      conformites: opts.resume.conformites,
      ecarts_total: opts.resume.total,
      ecarts_bloquants: opts.resume.ecartsBloquants,
    },
  })
}

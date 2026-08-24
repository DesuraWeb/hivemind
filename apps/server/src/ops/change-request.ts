import { createHash } from 'node:crypto'
import type { ApprovalSubtype } from '@silithid/shared'
import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/types'
import { type InboxItemRow, createInboxItem } from '../inbox/repo'
import { appendMessage } from '../loop/bus'
import { type ResultatApplication, appliquer, raconter, rendrePlan } from './apply'
import { apprendreDeLEchec } from './apprendre'
import type { Operation } from './operations'
import type { OpsExecutor, Serveur } from './types'

/**
 * Serveur en service : proposer, faire valider, appliquer.
 *
 * C'est la partie que Florian a demandée explicitement : « j'ai pas envie de
 * me rendre fou à aller taper des commandes moi-même, mais par contre avec
 * validation ». Silithid exécute donc réellement après approbation — on ne se
 * contente pas de lui donner la commande à recopier.
 *
 * ## Conséquence assumée, écrite pour que personne ne la découvre plus tard
 *
 * Silithid détient des accès en écriture sur des serveurs de production de
 * clients. C'est, de loin, la chose la plus dangereuse du système — plus
 * qu'un agent capable de réécrire la machine à états, parce qu'un `php.ini`
 * cassé n'a pas de `git revert`. Ce qui suit n'est pas du zèle, c'est le prix
 * de cette décision.
 *
 * ## Ce qui s'exécute est ce qui a été montré, octet pour octet
 *
 * Le plan est FIGÉ dans l'item d'inbox au moment de la proposition, avec ses
 * commandes rendues. L'exécution rejoue ce plan, jamais un plan recalculé
 * entre l'approbation et l'exécution — même si le catalogue a changé entre
 * les deux, même si le modèle proposerait autre chose maintenant.
 *
 * L'empreinte (`empreintePlan`) le vérifie plutôt que de le supposer : elle
 * est calculée à la proposition, recalculée à l'exécution, et un écart
 * refuse l'exécution au lieu de la faire.
 *
 * ## Détenir le port ne suffit pas à exécuter
 *
 * `OpsChangeApproval` reprend exactement `HumanSendApproval`
 * (`integrations/gmail.ts`) : constructeur privé, champ privé qui rend le type
 * nominal, une seule fabrique qui exige un item réellement résolu et approuvé.
 * Hors de ce module on ne peut ni l'instancier, ni fabriquer un objet littéral
 * qui lui soit assignable.
 */

/** Typé sur l'union partagée : un typo ne peut pas dériver silencieusement. */
export const OPS_INBOX_SUBTYPE: ApprovalSubtype = 'ops'

/** Ce qu'on relit d'un item d'inbox pour décider si une exécution est autorisée. */
export interface ResolvedOpsEvidence {
  id: string
  type: string
  subtype: string | null
  status: string
  humanResponse: Record<string, unknown> | null
  payload: Record<string, unknown>
}

/**
 * Empreinte du plan approuvé.
 *
 * Porte les opérations ET les commandes rendues : deux plans dont les
 * opérations se ressemblent mais dont une version du catalogue rendrait des
 * commandes différentes ne sont PAS le même plan. C'est justement ce cas-là
 * qu'on veut attraper.
 */
export function empreintePlan(operations: Operation[], commandes: string[]): string {
  return createHash('sha256').update(JSON.stringify({ operations, commandes })).digest('hex')
}

export class PlanModifieError extends Error {
  constructor(itemId: string) {
    super(
      `item ${itemId} : exécution refusée, le plan ne correspond plus à celui qui a été approuvé. Ce qui s'exécute doit être ce qui a été montré — repropose un plan plutôt que d'appliquer celui-ci.`,
    )
  }
}

export class OpsChangeApproval {
  private constructor(
    readonly inboxItemId: string,
    readonly serveurId: string,
    readonly operations: Operation[],
    private readonly approvedAt: Date,
  ) {}

  approvedAtIso(): string {
    return this.approvedAt.toISOString()
  }

  /**
   * La seule voie. Refuse tout ce qui n'est pas un item `approval`/`ops` déjà
   * résolu avec `approved: true`, et tout plan dont l'empreinte a bougé.
   */
  static fromResolvedInboxItem(evidence: ResolvedOpsEvidence): OpsChangeApproval {
    if (evidence.type !== 'approval' || evidence.subtype !== OPS_INBOX_SUBTYPE) {
      throw new Error(
        `item ${evidence.id} : exécution refusée, ce n'est pas une approbation d'exploitation (${evidence.type}/${evidence.subtype ?? 'sans sous-type'})`,
      )
    }
    if (evidence.status !== 'done') {
      throw new Error(
        `item ${evidence.id} : exécution refusée, item non résolu (statut ${evidence.status})`,
      )
    }
    if (evidence.humanResponse?.approved !== true) {
      throw new Error(
        `item ${evidence.id} : exécution refusée, aucune approbation humaine explicite`,
      )
    }

    const plan = evidence.payload.plan
    if (typeof plan !== 'object' || plan === null) {
      throw new Error(`item ${evidence.id} : exécution refusée, aucun plan rattaché`)
    }
    const { operations, commandes, empreinte, serveurId } = plan as {
      operations?: unknown
      commandes?: unknown
      empreinte?: unknown
      serveurId?: unknown
    }
    if (!Array.isArray(operations) || !Array.isArray(commandes) || typeof serveurId !== 'string') {
      throw new Error(`item ${evidence.id} : exécution refusée, plan incomplet`)
    }

    // Recalculée sur ce que l'item porte VRAIMENT, et comparée à ce qui y
    // était écrit. Un plan édité en base après l'approbation ne passe pas.
    const attendue = empreintePlan(operations as Operation[], commandes as string[])
    if (empreinte !== attendue) throw new PlanModifieError(evidence.id)

    return new OpsChangeApproval(evidence.id, serveurId, operations as Operation[], new Date())
  }
}

export interface ProposerChangementDeps {
  db: Kysely<Database>
  serveur: Serveur
  /** Le projet à l'origine de la demande, s'il y en a un. */
  projectId?: string | null
  runId?: string | null
}

export interface DemandeChangement {
  operations: Operation[]
  /** Ce que l'agent a lu, et ce qu'il suppose. Repris tel quel dans le panneau. */
  constate: string[]
  suppose: string[]
  /** Une phrase : pourquoi ce changement, pour ce projet. */
  motif: string
}

/**
 * Lève l'item d'inbox qui porte le plan.
 *
 * L'item doit permettre de décider **sans ouvrir un terminal** — c'est tout
 * l'intérêt pour Florian. Il porte donc : chaque commande exacte, chaque
 * sauvegarde, chaque retour arrière, ce qui ne se défait pas, et ce qui casse
 * si on ne fait rien.
 */
export async function proposerChangement(
  deps: ProposerChangementDeps,
  demande: DemandeChangement,
): Promise<InboxItemRow> {
  // Rend et VALIDE tout le plan avant de proposer quoi que ce soit : un plan
  // qu'on ne peut pas rendre ne doit jamais arriver en inbox, sans quoi
  // l'approbation porterait sur quelque chose d'inexécutable.
  const rendus = rendrePlan(demande.operations)
  const commandes = rendus.map((r) => r.commande)

  const irreversibles = rendus.filter((r) => r.inverse === null).map((r) => r.resume)

  return createInboxItem(deps.db, {
    type: 'approval',
    subtype: OPS_INBOX_SUBTYPE,
    projectId: deps.projectId ?? null,
    runId: deps.runId ?? null,
    fromRole: 'ops',
    title: `${deps.serveur.nom} · ${demande.operations.length} opération${demande.operations.length > 1 ? 's' : ''} à valider`,
    payload: {
      cause: demande.motif,
      serveur: {
        id: deps.serveur.id,
        nom: deps.serveur.nom,
        hote: deps.serveur.hote,
        etat: deps.serveur.etat,
      },
      constate: demande.constate,
      suppose: demande.suppose,
      // Ce que le panneau affiche, opération par opération.
      etapes: rendus.map((r, i) => ({
        resume: r.resume,
        commande: r.commande,
        sauvegarde: r.sauvegarde,
        inverse: r.inverse,
        raison: (demande.operations[i] as Operation & { raison?: string }).raison ?? null,
      })),
      // Nommé à part : c'est ce qu'on lit en premier avant d'approuver.
      irreversibles,
      plan: {
        serveurId: deps.serveur.id,
        operations: demande.operations,
        commandes,
        empreinte: empreintePlan(demande.operations, commandes),
      },
    },
  })
}

export interface ExecuterDeps {
  db: Kysely<Database>
  executor: OpsExecutor
  serveur: Serveur
  /** La stack du projet, pour que ce qui casse ici serve au prochain déploiement. */
  stack?: string | null
}

/**
 * Rejoue le plan approuvé. Exige la preuve de validation : détenir
 * l'exécuteur ne donne pas le pouvoir d'appliquer.
 *
 * Rend `null` sans rien faire pour un item qui n'est pas une approbation
 * d'exploitation ou pour un refus — un refus n'applique rien et ne défait
 * rien : il n'y avait rien de fait.
 */
export async function executerChangementApprouve(
  deps: ExecuterDeps,
  item: InboxItemRow,
): Promise<ResultatApplication | null> {
  if (item.type !== 'approval' || item.subtype !== OPS_INBOX_SUBTYPE) return null
  if (item.humanResponse?.approved !== true) return null

  const approbation = OpsChangeApproval.fromResolvedInboxItem({
    id: item.id,
    type: item.type,
    subtype: item.subtype,
    status: item.status,
    humanResponse: item.humanResponse,
    payload: item.payload,
  })

  if (approbation.serveurId !== deps.serveur.id) {
    throw new Error(
      `item ${item.id} : exécution refusée, le plan vise le serveur ${approbation.serveurId} et non ${deps.serveur.id}`,
    )
  }

  const resultat = await appliquer(
    { executor: deps.executor, serveur: deps.serveur },
    approbation.operations,
  )

  const recit = raconter(resultat, deps.serveur)

  // Trace dans l'item lui-même, comme pour un email envoyé : sans elle, rien
  // ne distingue un item approuvé dont le changement est passé d'un item
  // approuvé dont l'exécution a échoué.
  await deps.db
    .updateTable('inbox_items')
    .set({
      payload: sql`payload || ${JSON.stringify({
        applique: {
          at: new Date().toISOString(),
          approvedAt: approbation.approvedAtIso(),
          ok: resultat.ok,
          recit,
        },
      })}::jsonb`,
    })
    .where('id', '=', item.id)
    .execute()

  if (item.runId) {
    await appendMessage(deps.db, {
      runId: item.runId,
      fromRole: 'ops',
      toRole: 'system',
      kind: 'report',
      body: recit,
      meta: { inboxItemId: item.id, ok: resultat.ok, serveur: deps.serveur.nom },
    })
  }

  // Un échec en cours d'exécution laisse le serveur dans un état que personne
  // ne connaît : ça doit se VOIR, et une ligne de log ne se voit pas.
  if (!resultat.ok) {
    // Source 3 de l'apprentissage. Enveloppé : une trouvaille est additive, et
    // la laisser lever ici empêcherait l'alerte d'être écrite — donc ferait
    // disparaître la seule trace d'un serveur laissé à moitié configuré.
    if (item.projectId && deps.stack) {
      try {
        await apprendreDeLEchec(
          { db: deps.db, projectId: item.projectId, stack: deps.stack, runId: item.runId },
          resultat,
        )
      } catch {
        // Volontairement muet : l'alerte ci-dessous compte plus.
      }
    }

    await createInboxItem(deps.db, {
      type: 'alert',
      projectId: item.projectId,
      runId: item.runId,
      fromRole: 'ops',
      title: `Changement interrompu · ${deps.serveur.nom}`,
      payload: {
        cause: `Arrêt sur « ${resultat.echec?.nom} » · le serveur est dans un état intermédiaire`,
        ctx: recit,
        sourceItemId: item.id,
        appliquees: resultat.appliquees.map((a) => a.resume),
        nonTentees: resultat.nonTentees,
        retourArriere: resultat.echec?.retourArriere ?? [],
        irreversibles: resultat.echec?.irreversibles ?? [],
      },
    })
  }

  return resultat
}

import type { ApprovalSubtype } from '@silithid/shared'
import { type Kysely, sql } from 'kysely'
import type { CercleMemoire, Database } from '../db/types'
import { type InboxItemRow, createInboxItem } from '../inbox/repo'
import { appendMessage } from '../loop/bus'
import type { CandidatSavoir } from '../runtime/structured'
import { leverConflit, trouverConflit } from './conflict'
import { type Savoir, archiver } from './store'

/**
 * La TROUVAILLE et la PROPOSITION (Phase 7, Task 3).
 *
 * Le cycle est TROUVAILLE → PROPOSITION → CORRECTION → ARCHIVAGE → RAPPEL.
 * Ce fichier tient les deux premières étapes, et la bascule vers la
 * quatrième. Il n'archive jamais depuis un agent : `archiverSavoirApprouve`
 * n'est appelable qu'avec un item d'inbox déjà résolu par un humain, et c'est
 * la formulation de cet humain qui est archivée quand il en a donné une.
 *
 * ## Levé EN PARALLÈLE du flux, comme les deux autres gates
 *
 * Même mécanisme que `deploy/prod-gate.ts` et `loop/judge-contradiction.ts` :
 * un item écrit par `inbox/repo.ts::createInboxItem`, sans le moindre
 * événement ajouté à `domain/run-state.ts`. C'est ce qui rend le contrat du
 * plan vrai par construction plutôt que par convention : une proposition de
 * savoir ne peut pas réveiller une boucle, puisqu'aucun chemin ne relie ces
 * items à la machine à états. Elle n'est pas non plus une `alert` : c'est une
 * `approval`, elle attend la revue du matin.
 *
 * ## Le cercle visé n'est pas choisi par l'agent
 *
 * Le garant déclare une NATURE de cercle ; le serveur résout l'instance
 * depuis le projet du run. Un garant ne peut pas proposer un savoir dans le
 * globe d'un autre : il n'a aucun moyen d'en nommer un. Quand la nature
 * demandée n'a pas d'instance pour ce run (cercle `client` sur un projet sans
 * client), le candidat est ÉCARTÉ et la raison tracée — jamais rangé dans un
 * cercle plus large que celui demandé. Élargir l'audience d'un savoir sans
 * que personne ne l'ait décidé serait exactement le genre de glissement que
 * cette phase interdit.
 */

/** Sous-type du pack DA (§02, « VALIDATION · SAVOIR »). Typé sur l'union partagée : un typo ne peut pas dériver. */
export const SAVOIR_INBOX_SUBTYPE: ApprovalSubtype = 'savoir'

/** Au-delà, le titre cesse d'être un titre. Le contenu complet reste dans le payload. */
const MAX_TITRE = 150

/**
 * L'empreinte anti-répétition : cercle + instance + sujet normalisé.
 *
 * Ce n'est PAS une empreinte du contenu. Un refus doit survivre à une
 * reformulation — sinon il n'empêche que la première répétition, et l'inbox
 * se remplit quand même de ce que Florian a déjà refusé, à la virgule près.
 * Le sujet est déjà la clé que le projet a choisie pour la détection de
 * conflit (arbitrage du 15/08) : la réutiliser ici évite une seconde notion
 * d'identité qui divergerait de la première.
 *
 * La limite, assumée : un garant qui redéclare la même trouvaille sous un
 * AUTRE sujet passera à travers. C'est le même angle mort que la détection de
 * conflit, et il se referme du même côté — la revue de péremption (Task 5).
 */
export function empreinteSavoir(
  cercle: CercleMemoire,
  cercleId: string | null,
  sujet: string,
): string {
  return `${cercle}:${cercleId ?? 'hive'}:${sujet.trim().toLowerCase()}`
}

interface CibleCercle {
  cercle: CercleMemoire
  cercleId: string | null
  /** Libellé « proposé pour : … » du pack DA. */
  libelle: string
}

interface ContexteProjet {
  projectId: string
  projectName: string
  globeId: string
  globeName: string
  clientId: string | null
  clientName: string | null
}

function resoudreCible(candidat: CandidatSavoir, ctx: ContexteProjet): CibleCercle | string {
  switch (candidat.cercle) {
    case 'projet':
      return {
        cercle: 'projet',
        cercleId: ctx.projectId,
        libelle: `mémoire du projet · ${ctx.projectName}`,
      }
    case 'client':
      if (!ctx.clientId) {
        return "cercle « client » demandé, mais ce projet n'est rattaché à aucun client"
      }
      return {
        cercle: 'client',
        cercleId: ctx.clientId,
        libelle: `mémoire du client · ${ctx.clientName ?? 'sans nom'}`,
      }
    case 'globe':
      return {
        cercle: 'globe',
        cercleId: ctx.globeId,
        libelle: `mémoire du globe · ${ctx.globeName}`,
      }
    case 'hive':
      return { cercle: 'hive', cercleId: null, libelle: 'conscience de Hive' }
  }
}

/** Ce qu'une empreinte a déjà produit en inbox. `null` : rien qui doive faire taire une nouvelle proposition. */
type Anteriorite = 'ouvert' | 'refuse' | null

/**
 * Un refus est déjà enregistré, de façon permanente, dans `inbox_items`
 * (`status` + `human_response`) : aucune table de plus n'est nécessaire pour
 * s'en souvenir, et une seconde source de vérité sur « qu'a refusé Florian »
 * divergerait au premier incident — ce projet a déjà tranché ce genre de
 * question trois fois.
 *
 * Un item APPROUVÉ n'est pas une antériorité bloquante : le savoir existe
 * alors réellement, et une nouvelle proposition sur le même sujet est un
 * CONFLIT (Task 4), pas une répétition. On la laisse passer.
 */
async function anteriorite(db: Kysely<Database>, empreinte: string): Promise<Anteriorite> {
  const lignes = await db
    .selectFrom('inbox_items')
    .select(['status', 'human_response'])
    .where('subtype', '=', SAVOIR_INBOX_SUBTYPE)
    .where(sql<string>`payload->>'empreinte'`, '=', empreinte)
    .execute()

  if (lignes.some((l) => l.status === 'open')) return 'ouvert'
  // `dismissed` compte comme un refus : l'item a été écarté sans réponse, le
  // reproposer serait exactement la répétition qu'on veut éviter.
  if (lignes.some((l) => l.human_response?.approved !== true)) return 'refuse'
  return null
}

export interface ProposerSavoirsOptions {
  runId: string
  projectId: string
  candidats: CandidatSavoir[]
}

export interface CandidatEcarte {
  sujet: string
  raison: string
}

export interface ResultatProposition {
  proposes: InboxItemRow[]
  ecartes: CandidatEcarte[]
}

function titre(contenu: string): string {
  const plat = contenu.trim().replace(/\s+/g, ' ')
  const coupe = plat.length > MAX_TITRE ? `${plat.slice(0, MAX_TITRE - 1).trimEnd()}…` : plat
  return `« ${coupe} »`
}

/**
 * Ce qui se passe réellement à la résolution. Écrit dans l'item plutôt que
 * supposé par le panneau : les trois issues du pack DA n'ont de sens que si
 * elles disent laquelle archive quoi.
 */
const ON_APPROVE =
  'Archiver tel quel : la formulation ci-dessous entre dans le cercle visé. ' +
  'Corriger puis archiver : votre formulation remplace celle du garant, et c’est elle qui sera rappelée · ' +
  "la sienne n'est jamais archivée. Refuser : rien n'est archivé, et le même sujet ne sera plus reproposé " +
  'dans ce cercle.'

/**
 * Lève un item `approval`/`savoir` par candidat retenu.
 *
 * Ne lève RIEN quand la liste est vide : un run qui n'apprend rien produit
 * zéro item, jamais un item vide. C'est le cas normal, et c'est ce qui garde
 * la revue du matin lisible.
 */
export async function proposerSavoirs(
  db: Kysely<Database>,
  opts: ProposerSavoirsOptions,
): Promise<ResultatProposition> {
  if (opts.candidats.length === 0) return { proposes: [], ecartes: [] }

  const ctxLigne = await db
    .selectFrom('projects')
    .innerJoin('globes', 'globes.id', 'projects.globe_id')
    .leftJoin('clients', 'clients.id', 'projects.client_id')
    .select([
      'projects.id as projectId',
      'projects.name as projectName',
      'globes.id as globeId',
      'globes.name as globeName',
      'clients.id as clientId',
      'clients.name as clientName',
    ])
    .where('projects.id', '=', opts.projectId)
    .executeTakeFirstOrThrow()
  const ctx: ContexteProjet = ctxLigne

  const proposes: InboxItemRow[] = []
  const ecartes: CandidatEcarte[] = []
  // Deux candidats du MÊME verdict peuvent viser le même sujet dans le même
  // cercle : la base ne les verrait pas puisqu'aucun n'est encore écrit.
  const vusDansCeVerdict = new Set<string>()

  for (const candidat of opts.candidats) {
    const cible = resoudreCible(candidat, ctx)
    if (typeof cible === 'string') {
      ecartes.push({ sujet: candidat.sujet, raison: cible })
      continue
    }

    const empreinte = empreinteSavoir(cible.cercle, cible.cercleId, candidat.sujet)
    if (vusDansCeVerdict.has(empreinte)) {
      ecartes.push({ sujet: candidat.sujet, raison: 'sujet déjà proposé par ce même verdict' })
      continue
    }
    const deja = await anteriorite(db, empreinte)
    if (deja === 'ouvert') {
      ecartes.push({
        sujet: candidat.sujet,
        raison: 'une proposition sur ce sujet attend déjà dans l’inbox',
      })
      continue
    }
    if (deja === 'refuse') {
      ecartes.push({
        sujet: candidat.sujet,
        raison: 'ce sujet a déjà été refusé pour ce cercle · non reproposé',
      })
      continue
    }
    vusDansCeVerdict.add(empreinte)

    // Un savoir ACTIF de même sujet dans le même cercle : ce n'est pas une
    // proposition ordinaire, c'est une contradiction. Elle part en item de
    // CONFLIT — l'existant et la proposition côte à côte — plutôt qu'en
    // validation simple, qui laisserait Florian archiver un second savoir sans
    // voir qu'il en contredit un premier.
    const existant = await trouverConflit(db, cible, candidat.sujet)
    if (existant) {
      const conflit = await leverConflit(db, {
        existant,
        propose: { sujet: candidat.sujet, contenu: candidat.contenu },
        projectId: ctx.projectId,
        runId: opts.runId,
      })
      ecartes.push({
        sujet: candidat.sujet,
        raison: `contredit un savoir actif · item de conflit ${conflit.id}`,
      })
      continue
    }

    const item = await createInboxItem(db, {
      type: 'approval',
      subtype: SAVOIR_INBOX_SUBTYPE,
      projectId: ctx.projectId,
      runId: opts.runId,
      // Le garant, pas 'system' : c'est sa trouvaille, et l'UI affiche ce
      // rôle à côté du titre.
      fromRole: 'garant',
      title: titre(candidat.contenu),
      payload: {
        cause: candidat.sujet,
        ctx: `${ctx.projectName} · garant (run ${opts.runId}) · proposé pour : ${cible.libelle}`,
        savoir: {
          sujet: candidat.sujet,
          contenu: candidat.contenu,
          cercle: cible.cercle,
          cercle_id: cible.cercleId,
          cible: cible.libelle,
          ...(candidat.stack ? { stack: candidat.stack } : {}),
          source: {
            run_id: opts.runId,
            project_id: ctx.projectId,
            project_name: ctx.projectName,
            role: 'garant',
          },
          on_approve: ON_APPROVE,
        },
        empreinte,
      },
    })
    proposes.push(item)
  }

  // Trace dans la timeline du run. Écrite seulement s'il y a quelque chose à
  // dire : un run sans candidat n'ajoute pas une ligne de bruit au bus. Les
  // candidats écartés y figurent avec leur raison — sans ça, une suppression
  // par antériorité serait invisible, et « le garant n'a rien proposé »
  // deviendrait indistinguable de « on a fait taire sa proposition ».
  await appendMessage(db, {
    runId: opts.runId,
    fromRole: 'garant',
    toRole: 'system',
    kind: 'info',
    body: [
      `Savoirs proposés : ${proposes.length} · écartés : ${ecartes.length}.`,
      ...ecartes.map((e) => `- « ${e.sujet} » : ${e.raison}`),
    ].join('\n'),
    meta: {
      savoirs_proposes: proposes.map((p) => p.id),
      savoirs_ecartes: ecartes,
    },
  })

  return { proposes, ecartes }
}

const CERCLES: readonly CercleMemoire[] = ['projet', 'client', 'globe', 'hive']

function estCercle(valeur: unknown): valeur is CercleMemoire {
  return typeof valeur === 'string' && (CERCLES as readonly string[]).includes(valeur)
}

/** Une correction vide (champ laissé tel quel, ou effacé) n'est pas une correction. */
function corrigeOuOrigine(corrige: unknown, origine: string): string {
  return typeof corrige === 'string' && corrige.trim().length > 0 ? corrige : origine
}

/**
 * Action serveur déclenchée après résolution d'un item d'inbox, appelée
 * depuis `POST /api/inbox/:id/resolve` — même patron que
 * `communication/client-email.ts::sendApprovedClientEmail`.
 *
 * Rend `null` sans rien archiver pour tout item qui n'est pas une proposition
 * de savoir, et pour un refus. Un refus n'archive rien : ni en l'état, ni
 * « pour mémoire ». Ce qu'il laisse derrière lui, c'est l'item résolu
 * lui-même, qui empêchera la reproposition du même sujet.
 *
 * **La formulation corrigée fait foi.** Si l'humain a réécrit le contenu
 * (`response.text`), c'est SA phrase qui est archivée, jamais celle du
 * garant. Celle du garant reste lisible dans le payload de l'item, comme
 * trace de ce qui a été proposé — elle n'entre jamais dans le rappel.
 */
export async function archiverSavoirApprouve(
  db: Kysely<Database>,
  item: InboxItemRow,
): Promise<Savoir | null> {
  if (item.type !== 'approval' || item.subtype !== SAVOIR_INBOX_SUBTYPE) return null
  const reponse = item.humanResponse
  if (reponse?.approved !== true) return null

  const propose = item.payload.savoir
  if (typeof propose !== 'object' || propose === null) {
    throw new Error(`item ${item.id} : payload.savoir absent ou malformé`)
  }
  const champs = propose as {
    sujet?: unknown
    contenu?: unknown
    cercle?: unknown
    cercle_id?: unknown
    stack?: unknown
  }
  if (typeof champs.sujet !== 'string' || typeof champs.contenu !== 'string') {
    throw new Error(`item ${item.id} : payload.savoir sans sujet ni contenu exploitables`)
  }
  if (!estCercle(champs.cercle)) {
    throw new Error(`item ${item.id} : cercle « ${String(champs.cercle)} » inconnu`)
  }

  // La formulation de l'humain écrase celle de l'agent dès qu'elle existe.
  const contenu = corrigeOuOrigine(reponse.text, champs.contenu)
  const sujet = corrigeOuOrigine(reponse.sujet, champs.sujet)

  return archiver(db, {
    cercle: champs.cercle,
    cercleId: typeof champs.cercle_id === 'string' ? champs.cercle_id : null,
    sujet,
    contenu,
    ...(typeof champs.stack === 'string' ? { stack: champs.stack } : {}),
    origineRunId: item.runId,
    origineItemId: item.id,
  })
}

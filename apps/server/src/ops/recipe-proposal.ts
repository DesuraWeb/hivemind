import type { ApprovalSubtype } from '@silithid/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { type InboxItemRow, createInboxItem } from '../inbox/repo'
import { type NomOperation, estAuCatalogue, rendre } from './operations'
import {
  type EtapeRecette,
  RECETTES_GENERIQUES,
  STACK_RECIPES_SETTINGS_KEY,
  chargerRecettes,
} from './recipes'

/**
 * Ajouter une ÉTAPE à une recette — la moitié qui ne s'accumule pas toute
 * seule.
 *
 * ## Pourquoi celle-ci passe par une décision humaine et pas les rappels
 *
 * Un rappel est du texte : il informe un agent, il ne fait rien. Une étape
 * s'EXÉCUTE, en champ libre, sur le prochain serveur vierge de cette stack —
 * sans validation intermédiaire, c'est tout le principe du champ libre.
 *
 * Une étape qui s'ajouterait d'elle-même serait donc du pouvoir qui s'élargit
 * sans que personne ne l'ait décidé. C'est exactement la ligne : le savoir
 * s'accumule tout seul, le pouvoir ne s'élargit que par une décision humaine.
 *
 * ## Deux garde-fous, pas un
 *
 * `chargerRecettes` refuse déjà, à la LECTURE, toute recette qui référence une
 * opération inconnue. On refuse en plus à l'ÉCRITURE. Ce n'est pas de la
 * redondance : la lecture protège des recettes écrites à la main dans les
 * réglages, l'écriture protège de ce chemin-ci. Un seul des deux laisserait
 * l'autre porte ouverte.
 *
 * ## Ce qui est proposé porte sa commande
 *
 * L'item d'inbox montre la commande rendue, comme le panneau d'un changement
 * serveur. Approuver « ajouter `installer_paquet` à la recette Astro » sans
 * voir ce que ça exécutera reviendrait à signer un chèque en blanc pour tous
 * les déploiements Astro à venir.
 */

/** Typé sur l'union partagée : un typo ne peut pas dériver silencieusement. */
export const RECETTE_INBOX_SUBTYPE: ApprovalSubtype = 'recette'

export interface ProposerEtapeDeps {
  db: Kysely<Database>
  /** La stack visée, telle qu'elle sera indexée dans les réglages. */
  stack: string
  projectId?: string | null
  runId?: string | null
}

export interface EtapeProposee {
  nom: NomOperation
  pourquoi: string
}

export class EtapeHorsCatalogueError extends Error {
  constructor(nom: string) {
    super(
      `étape « ${nom} » refusée : absente du catalogue. Une recette COMPOSE des opérations existantes, elle n'en crée pas — ajouter une opération est une décision qui passe par un commit, jamais par une validation d'inbox.`,
    )
  }
}

/**
 * Lève un item par étape proposée.
 *
 * Dédoublonné contre la recette courante : proposer d'ajouter ce qui y est
 * déjà remplirait l'inbox à chaque déploiement de la même stack. Un item
 * ouvert sur la même étape bloque aussi un doublon, pour la même raison.
 */
export async function proposerEtapes(
  deps: ProposerEtapeDeps,
  etapes: EtapeProposee[],
): Promise<InboxItemRow[]> {
  if (etapes.length === 0) return []

  const stack = deps.stack.toLowerCase()
  const courantes = new Set((await lireEtapes(deps.db, stack)).map((e) => e.operation))

  const dejaOuverts = await deps.db
    .selectFrom('inbox_items')
    .select('payload')
    .where('type', '=', 'approval')
    .where('subtype', '=', RECETTE_INBOX_SUBTYPE)
    .where('status', '=', 'open')
    .execute()
  const enAttente = new Set(
    dejaOuverts
      .map((i) => (i.payload as { etape?: { stack?: unknown; nom?: unknown } }).etape)
      .filter((e) => e?.stack === stack)
      .map((e) => String(e?.nom)),
  )

  const items: InboxItemRow[] = []
  for (const etape of etapes) {
    if (!estAuCatalogue(etape.nom)) throw new EtapeHorsCatalogueError(etape.nom)
    if (courantes.has(etape.nom) || enAttente.has(etape.nom)) continue

    // La commande telle qu'elle s'exécutera. Les paramètres restent vides à ce
    // stade : une étape de recette est un gabarit que l'agent complète pour
    // chaque projet. On rend donc ce qu'on peut, et on le dit.
    let commande: string | null = null
    try {
      commande = rendre({ nom: etape.nom, params: gabarit(etape.nom) }).commande
    } catch {
      commande = null
    }

    items.push(
      await createInboxItem(deps.db, {
        type: 'approval',
        subtype: RECETTE_INBOX_SUBTYPE,
        projectId: deps.projectId ?? null,
        runId: deps.runId ?? null,
        fromRole: 'ops',
        title: `Recette ${stack} · ajouter « ${etape.nom} »`,
        payload: {
          cause: etape.pourquoi,
          ctx: `Cette opération s'exécutera d'office, sans validation, sur chaque prochain serveur VIERGE de la stack « ${stack} ».`,
          etape: { stack, nom: etape.nom, pourquoi: etape.pourquoi },
          commande,
          on_approve:
            'Approuver : l’étape rejoint la recette de cette stack et s’exécutera sur tous les ' +
            'prochains provisionings en champ libre. Refuser : rien ne change, et l’agent ' +
            'pourra continuer à la proposer au cas par cas dans un plan.',
        },
      }),
    )
  }

  return items
}

/**
 * Écrit l'étape dans les réglages, après validation humaine.
 *
 * Rend `null` sans rien écrire pour tout item qui n'est pas une approbation de
 * recette, et pour un refus — refuser ne change rien, et l'agent garde le
 * droit de proposer l'opération au cas par cas dans un plan.
 */
export async function ajouterEtapeApprouvee(
  db: Kysely<Database>,
  item: InboxItemRow,
): Promise<EtapeRecette | null> {
  if (item.type !== 'approval' || item.subtype !== RECETTE_INBOX_SUBTYPE) return null
  if (item.humanResponse?.approved !== true) return null

  const brut = item.payload.etape
  if (typeof brut !== 'object' || brut === null) {
    throw new Error(`item ${item.id} : payload.etape absent ou malformé`)
  }
  const { stack, nom, pourquoi } = brut as {
    stack?: unknown
    nom?: unknown
    pourquoi?: unknown
  }
  if (typeof stack !== 'string' || typeof nom !== 'string') {
    throw new Error(`item ${item.id} : étape sans stack ni opération exploitables`)
  }
  // Le second garde-fou. Un item forgé en base entre la proposition et la
  // validation ne peut pas glisser une opération inconnue dans une recette.
  if (!estAuCatalogue(nom)) throw new EtapeHorsCatalogueError(nom)

  // La formulation de Florian écrase celle de l'agent, comme pour un savoir.
  const raison =
    typeof item.humanResponse.text === 'string' && item.humanResponse.text.trim().length > 0
      ? item.humanResponse.text.trim()
      : typeof pourquoi === 'string'
        ? pourquoi
        : 'ajoutée par validation humaine'

  const recettes = await lireToutes(db)
  const cible = recettes[stack] ?? {
    resume: `Recette ${stack} · construite à partir des déploiements.`,
    etapes: [],
    rappels: [],
  }

  if (cible.etapes.some((e) => e.operation === nom)) return null

  const etape: EtapeRecette = { operation: nom, pourquoi: raison }
  recettes[stack] = { ...cible, etapes: [...cible.etapes, etape] }

  await db
    .insertInto('settings')
    .values({ key: STACK_RECIPES_SETTINGS_KEY, value: JSON.stringify(recettes) })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({ value: JSON.stringify(recettes), updated_at: new Date() }),
    )
    .execute()

  return etape
}

async function lireToutes(db: Kysely<Database>) {
  const row = await db
    .selectFrom('settings')
    .select('value')
    .where('key', '=', STACK_RECIPES_SETTINGS_KEY)
    .executeTakeFirst()
  return chargerRecettes(row?.value ?? RECETTES_GENERIQUES).recettes
}

async function lireEtapes(db: Kysely<Database>, stack: string): Promise<EtapeRecette[]> {
  return (await lireToutes(db))[stack]?.etapes ?? []
}

/**
 * Paramètres de démonstration, uniquement pour rendre une commande lisible
 * dans l'item. Jamais persistés : une étape de recette est un gabarit que
 * l'agent complète par projet, et figer des paramètres ici les appliquerait à
 * tous les projets de la stack.
 */
function gabarit(nom: NomOperation): Record<string, unknown> {
  switch (nom) {
    case 'lire_fichier':
      return { chemin: '/etc/exemple.conf' }
    case 'ecrire_fichier':
      return { chemin: '/etc/exemple.conf', contenu: '…' }
    case 'installer_paquet':
      return { paquet: 'exemple' }
    case 'activer_extension_php':
      return { extension: 'exemple' }
    case 'recharger_service':
      return { service: 'exemple' }
    case 'poser_cron':
      return {
        nom: 'exemple',
        planification: '0 3 * * *',
        utilisateur: 'root',
        commande: '/bin/true',
      }
  }
}

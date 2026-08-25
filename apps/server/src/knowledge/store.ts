import { randomUUID } from 'node:crypto'
import type { DomaineSavoir } from '@silithid/shared'
import type { Kysely } from 'kysely'
import type { CercleMemoire, Database } from '../db/types'

/**
 * Le magasin de savoirs : écriture, correction, archivage.
 *
 * ## Versionné, jamais écrasé
 *
 * Corriger un savoir crée une VERSION. La précédente reste lisible et
 * archivée. Deux raisons, et la seconde compte plus que la première : le pack
 * affiche `v1`/`v2`, et surtout une correction doit pouvoir se relire — un
 * savoir qui change silencieusement est un savoir auquel on ne peut plus se
 * fier.
 *
 * L'invariant « une seule version active par savoir » est tenu par un index
 * unique partiel, pas par du code applicatif : deux écritures concurrentes ne
 * peuvent pas produire deux actifs.
 *
 * ## Ce que ce fichier ne fait pas
 *
 * Il n'écrit jamais depuis un agent. Un savoir naît d'une PROPOSITION, passe
 * par une correction humaine, et c'est la formulation de l'humain qui est
 * archivée (spec §02). Le chemin agent → base n'existe pas, et c'est
 * volontaire — c'est ce qui distingue une mémoire d'un dépotoir.
 */

export interface Savoir {
  id: string
  racineId: string
  version: number
  cercle: CercleMemoire
  cercleId: string | null
  sujet: string
  contenu: string
  stack: string | null
  /**
   * Où ce savoir vaut : un hébergeur nommé, un type d'hébergement, ou `null`
   * quand il vaut partout (migration 0016). Rendu à l'écran pour que Florian
   * puisse corriger une portée mal déclarée — c'est la seule façon de réparer
   * un savoir devenu invisible parce qu'il a été rangé trop bas.
   */
  hebergement: string | null
  /** `code` (dev, garant) ou `exploitation` (agent ops). Voir migration 0012. */
  domaine: DomaineSavoir
  rappels: number
  createdAt: Date
}

export interface CercleRef {
  cercle: CercleMemoire
  /** Requis sauf pour `hive`, qui n'a pas d'instance. */
  cercleId?: string | null
}

export interface ArchiverInput extends CercleRef {
  sujet: string
  contenu: string
  stack?: string | null
  /**
   * Le niveau auquel le savoir vaut : un hébergeur nommé, un type
   * d'hébergement, ou omis quand il vaut partout (migration 0016).
   *
   * Omis est le bon défaut : un savoir dont personne n'a déclaré la portée
   * vaut partout, ce qui est le comportement d'avant. L'inverse — supposer
   * qu'il est propre à un hébergeur — le rendrait invisible presque toujours.
   */
  hebergement?: string | null
  /**
   * Omis, `code` — le défaut de la colonne, et le bon : tous les savoirs qui
   * existaient avant la Phase 6 viennent du garant. Un savoir dont personne
   * n'a déclaré le domaine appartient au flux qui existait déjà.
   */
  domaine?: DomaineSavoir
  origineRunId?: string | null
  origineItemId?: string | null
}

function ligneVersSavoir(r: {
  id: string
  racine_id: string
  version: number
  cercle: CercleMemoire
  cercle_id: string | null
  sujet: string
  contenu: string
  stack: string | null
  hebergement: string | null
  domaine: DomaineSavoir
  rappels: number
  created_at: unknown
}): Savoir {
  return {
    id: r.id,
    racineId: r.racine_id,
    version: r.version,
    cercle: r.cercle,
    cercleId: r.cercle_id,
    sujet: r.sujet,
    contenu: r.contenu,
    stack: r.stack,
    hebergement: r.hebergement,
    domaine: r.domaine,
    rappels: r.rappels,
    createdAt: new Date(r.created_at as string),
  }
}

const COLONNES = [
  'id',
  'racine_id',
  'version',
  'cercle',
  'cercle_id',
  'sujet',
  'contenu',
  'stack',
  'hebergement',
  'domaine',
  'rappels',
  'created_at',
] as const

/** Archive un savoir neuf (version 1). Sa formulation est celle validée par un humain. */
export async function archiver(db: Kysely<Database>, input: ArchiverInput): Promise<Savoir> {
  const ligne = await db
    .insertInto('savoirs')
    .values({
      racine_id: randomUUID(),
      cercle: input.cercle,
      cercle_id: input.cercle === 'hive' ? null : (input.cercleId ?? null),
      sujet: input.sujet.trim(),
      contenu: input.contenu.trim(),
      stack: input.stack ?? null,
      hebergement: input.hebergement ?? null,
      ...(input.domaine ? { domaine: input.domaine } : {}),
      origine_run_id: input.origineRunId ?? null,
      origine_item_id: input.origineItemId ?? null,
    })
    .returning(COLONNES)
    .executeTakeFirstOrThrow()
  return ligneVersSavoir(ligne)
}

/**
 * Corrige un savoir : nouvelle version active, l'ancienne passe en archive.
 *
 * Les deux écritures sont dans une transaction. Sans elle, l'index unique
 * partiel refuserait la nouvelle version tant que l'ancienne est active — et
 * un échec entre les deux laisserait un savoir sans version active du tout,
 * donc invisible au rappel.
 */
export async function corriger(
  db: Kysely<Database>,
  racineId: string,
  contenu: string,
  sujet?: string,
): Promise<Savoir> {
  return db.transaction().execute(async (trx) => {
    const actuel = await trx
      .selectFrom('savoirs')
      .selectAll()
      .where('racine_id', '=', racineId)
      .where('etat', '=', 'actif')
      .executeTakeFirstOrThrow()

    await trx
      .updateTable('savoirs')
      .set({ etat: 'archive', archived_at: new Date() })
      .where('id', '=', actuel.id)
      .execute()

    const ligne = await trx
      .insertInto('savoirs')
      .values({
        racine_id: racineId,
        version: actuel.version + 1,
        cercle: actuel.cercle,
        cercle_id: actuel.cercle_id,
        sujet: (sujet ?? actuel.sujet).trim(),
        contenu: contenu.trim(),
        stack: actuel.stack,
        hebergement: actuel.hebergement,
        // Recopié comme le reste, et il ne l'était PAS — bug trouvé en
        // ajoutant la portée d'hébergement. Sans cette ligne, la nouvelle
        // version retombe sur le défaut de colonne (`code`) : reformuler un
        // savoir d'exploitation le faisait basculer en silence dans la mémoire
        // du dev. Invisible pour l'agent ops qui venait de l'apprendre, et du
        // bruit pour le garant qui ne l'a jamais demandé.
        domaine: actuel.domaine,
        origine_run_id: actuel.origine_run_id,
        origine_item_id: actuel.origine_item_id,
        // Le compteur d'utilité NE REPART PAS à zéro : c'est le savoir qui a
        // servi N fois, pas sa formulation. Le remettre à zéro ferait remonter
        // en tête de la revue de péremption un savoir qu'on vient justement de
        // confirmer en le corrigeant.
        rappels: actuel.rappels,
      })
      .returning(COLONNES)
      .executeTakeFirstOrThrow()
    return ligneVersSavoir(ligne)
  })
}

/** Retire un savoir du rappel sans effacer son historique. */
export async function archiverDefinitivement(
  db: Kysely<Database>,
  racineId: string,
): Promise<void> {
  await db
    .updateTable('savoirs')
    .set({ etat: 'archive', archived_at: new Date() })
    .where('racine_id', '=', racineId)
    .where('etat', '=', 'actif')
    .execute()
}

/** Toutes les versions d'un savoir, de la plus récente à la plus ancienne. */
export async function historique(db: Kysely<Database>, racineId: string): Promise<Savoir[]> {
  const lignes = await db
    .selectFrom('savoirs')
    .select(COLONNES)
    .where('racine_id', '=', racineId)
    .orderBy('version', 'desc')
    .execute()
  return lignes.map(ligneVersSavoir)
}

/**
 * Savoirs actifs d'un cercle donné. Le rappel en cascade
 * (`recall.ts`) appelle ceci une fois par cercle.
 */
export async function actifsDuCercle(db: Kysely<Database>, ref: CercleRef): Promise<Savoir[]> {
  let q = db
    .selectFrom('savoirs')
    .select(COLONNES)
    .where('etat', '=', 'actif')
    .where('cercle', '=', ref.cercle)
  q =
    ref.cercle === 'hive'
      ? q.where('cercle_id', 'is', null)
      : q.where('cercle_id', '=', ref.cercleId ?? '')
  return (await q.orderBy('created_at', 'asc').execute()).map(ligneVersSavoir)
}

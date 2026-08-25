import { type Kysely, sql } from 'kysely'
import type { CercleMemoire, Database } from '../db/types'

/**
 * L'état réel de la mémoire, pour l'écran `/conscience`.
 *
 * ## Pourquoi cette route existe
 *
 * L'écran déclarait « la conscience collective n'existe pas · aucune table de
 * savoirs, aucun rappel compté, aucun emprunt ». C'était vrai quand il a été
 * écrit ; la Phase 7 a livré les quatre cercles, le versionnement, le compteur
 * de rappels, l'emprunt entre globes et la revue de péremption. **L'app niait
 * une fonctionnalité qu'elle avait** — la faute exactement inverse de celle
 * que ce dépôt s'astreint à éviter, et tout aussi coûteuse.
 *
 * Rien ne permettait de la corriger : la seule route existante
 * (`/api/savoirs/revue`) rend la FILE DE REVUE, pas la mémoire. Un écran qui
 * décrit la mémoire ne peut pas se contenter de ce qui est périmé.
 *
 * ## Ce qu'elle ne rend pas
 *
 * Aucun contenu de savoir n'est agrégé ici, seulement des comptes et les
 * sujets. Le contenu se lit dans la revue, savoir par savoir, avec ses
 * versions — le rendre en vrac ferait de cet écran un dépotoir de mémoire là
 * où il doit être une vue d'ensemble.
 *
 * Et **aucun secret ne peut en sortir** : la table `savoirs` ne porte ni
 * fiche client ni valeur de coffre, c'est structurel (migration 0007).
 */

export interface CercleApercu {
  cercle: CercleMemoire
  /** Savoirs actifs dans ce cercle, toutes instances confondues. */
  actifs: number
  /** Instances distinctes qui portent au moins un savoir · `null` pour `hive`, qui est unique. */
  instances: number | null
  /** Rappels cumulés · c'est la mesure d'utilité, pas le volume. */
  rappels: number
}

export interface ApercuMemoire {
  cercles: CercleApercu[]
  /** Total des savoirs actifs, tous cercles. */
  actifs: number
  /** Versions archivées · un savoir corrigé garde son historique lisible. */
  versions: number
  /** Savoirs qui n'ont JAMAIS servi à un agent. La mesure qui compte. */
  jamaisRappeles: number
  /** Le savoir le plus rappelé, s'il y en a un. */
  plusUtile: { sujet: string; cercle: CercleMemoire; rappels: number } | null
  emprunts: { actifs: number; lecture: number; fork: number }
  /** Savoirs de stack, par domaine (migration 0012). */
  stack: { code: number; exploitation: number }
}

const CERCLES: CercleMemoire[] = ['projet', 'client', 'globe', 'hive']

export async function apercuMemoire(db: Kysely<Database>): Promise<ApercuMemoire> {
  const parCercle = await db
    .selectFrom('savoirs')
    .select((eb) => [
      'cercle',
      eb.fn.countAll<string>().as('actifs'),
      sql<string>`count(distinct cercle_id)`.as('instances'),
      sql<string>`coalesce(sum(rappels), 0)`.as('rappels'),
    ])
    .where('etat', '=', 'actif')
    .groupBy('cercle')
    .execute()

  const index = new Map(parCercle.map((r) => [r.cercle, r]))
  const cercles: CercleApercu[] = CERCLES.map((cercle) => {
    const ligne = index.get(cercle)
    return {
      cercle,
      actifs: Number(ligne?.actifs ?? 0),
      // `hive` n'a pas d'instance : il est unique. Rendre `0` laisserait croire
      // à un cercle vide alors que la question ne se pose pas.
      instances: cercle === 'hive' ? null : Number(ligne?.instances ?? 0),
      rappels: Number(ligne?.rappels ?? 0),
    }
  })

  const totaux = await db
    .selectFrom('savoirs')
    .select((eb) => [
      sql<string>`count(*) filter (where etat = 'actif')`.as('actifs'),
      sql<string>`count(*) filter (where etat <> 'actif')`.as('versions'),
      sql<string>`count(*) filter (where etat = 'actif' and rappels = 0)`.as('jamaisRappeles'),
      sql<string>`count(*) filter (where etat = 'actif' and stack is not null and domaine = 'code')`.as(
        'stackCode',
      ),
      sql<string>`count(*) filter (where etat = 'actif' and stack is not null and domaine = 'exploitation')`.as(
        'stackOps',
      ),
      eb.val(0).as('ignore'),
    ])
    .executeTakeFirstOrThrow()

  const plusUtile = await db
    .selectFrom('savoirs')
    .select(['sujet', 'cercle', 'rappels'])
    .where('etat', '=', 'actif')
    .where('rappels', '>', 0)
    .orderBy('rappels', 'desc')
    .orderBy('created_at', 'asc')
    .limit(1)
    .executeTakeFirst()

  const emprunts = await db
    .selectFrom('emprunts_savoir')
    .select((eb) => [
      eb.fn.countAll<string>().as('actifs'),
      sql<string>`count(*) filter (where mode = 'lecture')`.as('lecture'),
      sql<string>`count(*) filter (where mode = 'fork')`.as('fork'),
    ])
    .where('etat', '=', 'actif')
    .executeTakeFirstOrThrow()

  return {
    cercles,
    actifs: Number(totaux.actifs),
    versions: Number(totaux.versions),
    jamaisRappeles: Number(totaux.jamaisRappeles),
    plusUtile: plusUtile
      ? { sujet: plusUtile.sujet, cercle: plusUtile.cercle, rappels: plusUtile.rappels }
      : null,
    emprunts: {
      actifs: Number(emprunts.actifs),
      lecture: Number(emprunts.lecture),
      fork: Number(emprunts.fork),
    },
    stack: { code: Number(totaux.stackCode), exploitation: Number(totaux.stackOps) },
  }
}

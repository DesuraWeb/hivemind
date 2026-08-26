import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/types'
import { lireAcces } from '../ops/credentials'
import type { SettingsStore } from '../settings/store'

/**
 * Où un projet se déploie, cible par cible.
 *
 * ## Ce que ça remplace
 *
 * Le staging réel était réglé globalement : un hôte, un utilisateur, une
 * racine, un domaine joker, une clé de coffre — pour TOUS les projets. Ça ne
 * survit pas au premier client hébergé ailleurs, et ça ne permettait pas de
 * déclarer une prod, qui n'existait comme cible d'aucune façon.
 *
 * ## Rien n'est recopié depuis le serveur
 *
 * L'hôte, l'utilisateur, le port, le type d'hébergement et l'accès au coffre
 * vivent sur `serveurs`. Cette table ne porte que ce qui est propre au couple
 * (projet, cible) : le répertoire, la branche, l'URL publique. Recopier
 * l'hôte ici créerait une seconde source de vérité qui divergerait au premier
 * changement d'IP.
 */

export type NomCible = 'staging' | 'prod'

export interface CibleDeploiement {
  id: string
  projectId: string
  cible: NomCible
  serveurId: string
  /** Nom du serveur · sert aussi de préfixe de clé dans le coffre. */
  serveurNom: string
  hote: string
  utilisateur: string
  port: number
  typeHebergement: string
  chemin: string
  branche: string
  domaine: string | null
}

const COLONNES = [
  'cibles_deploiement.id as id',
  'cibles_deploiement.project_id as projectId',
  'cibles_deploiement.cible as cible',
  'cibles_deploiement.serveur_id as serveurId',
  'serveurs.nom as serveurNom',
  'serveurs.hote as hote',
  'serveurs.utilisateur as utilisateur',
  'serveurs.port as port',
  'serveurs.type_hebergement as typeHebergement',
  'cibles_deploiement.chemin as chemin',
  'cibles_deploiement.branche as branche',
  'cibles_deploiement.domaine as domaine',
] as const

function versCible(r: Record<string, unknown>): CibleDeploiement {
  return {
    id: r.id as string,
    projectId: r.projectId as string,
    cible: r.cible as NomCible,
    serveurId: r.serveurId as string,
    serveurNom: r.serveurNom as string,
    hote: r.hote as string,
    utilisateur: r.utilisateur as string,
    port: r.port as number,
    typeHebergement: r.typeHebergement as string,
    chemin: r.chemin as string,
    branche: r.branche as string,
    domaine: (r.domaine ?? null) as string | null,
  }
}

export async function listerCibles(
  db: Kysely<Database>,
  projectId: string,
): Promise<CibleDeploiement[]> {
  const rows = await db
    .selectFrom('cibles_deploiement')
    .innerJoin('serveurs', 'serveurs.id', 'cibles_deploiement.serveur_id')
    .select(COLONNES)
    .where('cibles_deploiement.project_id', '=', projectId)
    .orderBy('cibles_deploiement.cible')
    .execute()
  return rows.map((r) => versCible(r as Record<string, unknown>))
}

export async function lireCible(
  db: Kysely<Database>,
  projectId: string,
  cible: NomCible,
): Promise<CibleDeploiement | null> {
  const row = await db
    .selectFrom('cibles_deploiement')
    .innerJoin('serveurs', 'serveurs.id', 'cibles_deploiement.serveur_id')
    .select(COLONNES)
    .where('cibles_deploiement.project_id', '=', projectId)
    .where('cibles_deploiement.cible', '=', cible)
    .executeTakeFirst()
  return row ? versCible(row as Record<string, unknown>) : null
}

export interface PoserCibleInput {
  projectId: string
  cible: NomCible
  serveurId: string
  chemin: string
  branche?: string
  domaine?: string | null
}

export class CheminInvalideError extends Error {
  constructor(chemin: string) {
    super(
      `chemin de déploiement refusé : « ${chemin} » · il doit être absolu et sans remontée de répertoire`,
    )
    this.name = 'CheminInvalideError'
  }
}

/**
 * Pose ou remplace la configuration d'une cible.
 *
 * Le chemin subit la MÊME validation que dans un plan d'exploitation : absolu,
 * sans `..`. Un chemin relatif se résoudrait depuis le répertoire de connexion
 * SSH, qui n'est pas le même selon le compte ; une remontée permettrait
 * d'écrire hors du répertoire du projet. C'est une valeur qu'un agent peut
 * proposer, donc elle est validée ici et pas seulement à l'écran.
 */
export async function poserCible(
  db: Kysely<Database>,
  input: PoserCibleInput,
): Promise<CibleDeploiement> {
  const chemin = input.chemin.trim()
  if (!chemin.startsWith('/') || chemin.includes('..')) {
    throw new CheminInvalideError(input.chemin)
  }

  await db
    .insertInto('cibles_deploiement')
    .values({
      project_id: input.projectId,
      cible: input.cible,
      serveur_id: input.serveurId,
      chemin,
      ...(input.branche ? { branche: input.branche } : {}),
      domaine: input.domaine ?? null,
    })
    .onConflict((oc) =>
      oc.columns(['project_id', 'cible']).doUpdateSet({
        serveur_id: input.serveurId,
        chemin,
        ...(input.branche ? { branche: input.branche } : {}),
        domaine: input.domaine ?? null,
        updated_at: sql`now()`,
      }),
    )
    .execute()

  const posee = await lireCible(db, input.projectId, input.cible)
  if (!posee) throw new Error('cible posée introuvable juste après son écriture')
  return posee
}

export async function retirerCible(
  db: Kysely<Database>,
  projectId: string,
  cible: NomCible,
): Promise<void> {
  await db
    .deleteFrom('cibles_deploiement')
    .where('project_id', '=', projectId)
    .where('cible', '=', cible)
    .execute()
}

/** Ce qu'il faut pour se connecter, une fois la cible résolue. */
export interface AccesCible extends CibleDeploiement {
  clePrivee: string
}

/**
 * Résout la cible ET son accès.
 *
 * L'accès vient du coffre par SERVEUR (`ops.<nom>.ssh_private_key`), jamais
 * d'une clé unique de déploiement : un jeu par machine, donc une clé
 * compromise n'ouvre pas le parc. C'est le même mécanisme que l'agent
 * d'exploitation utilise déjà, et pas un second à maintenir.
 *
 * Rend `null` quand la cible n'est pas configurée — ce n'est pas une panne,
 * c'est un projet dont on n'a pas encore dit où il va. Lève, en revanche,
 * quand la cible existe mais que sa clé manque : là il y a une configuration
 * à moitié faite, et la traiter comme « pas de cible » ferait retomber
 * silencieusement sur l'aperçu local.
 */
export async function resoudreAcces(
  db: Kysely<Database>,
  settings: SettingsStore,
  projectId: string,
  cible: NomCible,
): Promise<AccesCible | null> {
  const c = await lireCible(db, projectId, cible)
  if (!c) return null

  // `lireAcces` LÈVE quand le coffre ne porte pas la clé — jamais de repli,
  // jamais de valeur par défaut. On la laisse lever plutôt que de rattraper :
  // une cible configurée dont la clé manque est une configuration à moitié
  // faite, et la traiter comme « pas de cible » ferait retomber en silence sur
  // l'aperçu local, avec un juge qui statuerait sur une adresse éphémère.
  const acces = await lireAcces(settings, c.serveurNom)
  return { ...c, clePrivee: acces.clePrivee }
}

import { type Kysely, sql } from 'kysely'
import type { CercleMemoire, Database } from '../db/types'
import { archiverDefinitivement } from './store'

/**
 * La revue de péremption : ce qui reste vivant dans la mémoire.
 *
 * ## Ce que Hive met en tête
 *
 * Les savoirs **jamais rappelés**, puis les **plus anciens**. C'est le score
 * d'utilité de `recall.ts` qui sert enfin à quelque chose : un savoir que la
 * cascade n'a jamais servi depuis des mois est soit faux, soit inutile — dans
 * les deux cas il mérite un œil, et dans aucun des deux la machine ne peut
 * trancher à la place de Florian. L'index `savoirs_revue_idx (rappels,
 * created_at) where etat = 'actif'` existe pour exactement ce tri.
 *
 * ## Les deux gestes
 *
 * « Toujours vrai · garder » écrit `revue_at` (cf. migration 0008 pour les
 * trois écritures écartées). « Plus d'actualité · archiver » passe par
 * `archiverDefinitivement` du magasin : le savoir sort du rappel, ses versions
 * restent lisibles.
 *
 * ## Les non-traités reviennent
 *
 * Il n'y a pas de « session de revue » persistée, et c'est volontaire : la file
 * est un CALCUL sur l'état de la base, pas une liste figée à l'ouverture. Un
 * savoir qu'on n'a pas touché est toujours actif, toujours sans confirmation
 * récente, donc toujours dans la file au prochain passage. Quitter en cours de
 * route ne perd rien parce qu'il n'y avait rien à perdre.
 *
 * ## Ce que ce module ne fait PAS
 *
 * Il ne planifie rien et ne prévient personne — c'est le travail de
 * `revue-notif.ts`, qui calcule cette file toutes les semaines et lève un
 * rappel en inbox quand il y a une raison de parler. Ce module-ci reste un
 * calcul sur l'état de la base, sans horloge et sans effet de bord.
 *
 * `PERIODE_REVUE_JOURS` n'est toujours pas une échéance : c'est la durée
 * pendant laquelle un savoir confirmé reste hors de la file.
 */

/** Un trimestre. Durée pendant laquelle un savoir confirmé sort de la file. */
export const PERIODE_REVUE_JOURS = 90

/**
 * Plafond de la file rendue en une fois. Au-delà, les suivants viennent au
 * passage d'après : c'est exactement ce que « les non-traités reviennent »
 * garantit, et c'est préférable à mille cartes rendues d'un coup.
 */
export const LIMITE_FILE = 50

const JOUR_MS = 86_400_000

export interface SavoirARevoir {
  racineId: string
  version: number
  cercle: CercleMemoire
  /** Lisible : « fiche client Bastide », « mémoire du globe Desura », « conscience de Hive ». */
  cercleLabel: string
  sujet: string
  contenu: string
  /** Score d'utilité mesuré par `recall.ts`. 0 = jamais servi à un agent. */
  rappels: number
  /** Âge de CETTE version, en jours pleins. Une correction rajeunit le savoir : c'est voulu. */
  ageJours: number
  createdAt: string
  /** Dernière confirmation humaine, ou `null` si le savoir n'est jamais passé en revue. */
  revueAt: string | null
  /** Pourquoi Hive le propose ici, en chiffres vérifiables : « jamais rappelé · 94 j ». */
  pourquoi: string
}

export interface RevueSavoirs {
  periodeJours: number
  /** Total des savoirs actifs, revue comprise ou non. */
  actifs: number
  /** Total à revoir, qui peut dépasser `items.length` (cf. `LIMITE_FILE`). */
  aRevoir: number
  /** La phrase de Hive, CALCULÉE (cf. `phraseHive`). */
  hive: string
  items: SavoirARevoir[]
}

function labelCercle(
  cercle: CercleMemoire,
  noms: { projet: string | null; client: string | null; globe: string | null },
): string {
  switch (cercle) {
    case 'hive':
      return 'conscience de Hive'
    case 'projet':
      return noms.projet ? `projet ${noms.projet}` : 'projet · instance introuvable'
    case 'client':
      return noms.client ? `fiche client ${noms.client}` : 'fiche client · instance introuvable'
    case 'globe':
      return noms.globe ? `mémoire du globe ${noms.globe}` : 'globe · instance introuvable'
  }
}

function pluriel(n: number, mot: string): string {
  return `${n} ${mot}${n > 1 ? 's' : ''}`
}

/**
 * La ligne de justification d'un savoir. Uniquement des chiffres que la base
 * porte : le compteur de rappels et l'âge. Pas de « probablement obsolète » —
 * personne ici n'a lu le contenu.
 */
function pourquoi(rappels: number, ageJours: number, revueAt: Date | null): string {
  const usage = rappels === 0 ? 'jamais rappelé' : pluriel(rappels, 'rappel')
  const confirme = revueAt
    ? ` · confirmé il y a ${Math.floor((Date.now() - revueAt.getTime()) / JOUR_MS)} j`
    : ''
  return `${usage} · ${ageJours} j${confirme}`
}

/**
 * Ce que Hive dit en tête d'écran.
 *
 * **Calculée, jamais demandée à un modèle.** Une phrase rédigée coûterait un
 * échange à CHAQUE ouverture de l'écran, pour reformuler des nombres qu'on a
 * déjà — et ce projet a refusé ce genre de coût récurrent plusieurs fois (la
 * détection de conflit par sujet déclaré plutôt que par modèle, l'extraction
 * des candidats dans la sortie structurée du garant plutôt qu'en appel
 * supplémentaire). Le pack fait dire à Hive « deux me semblent périmées » :
 * c'est un jugement sur le CONTENU, que ni ce module ni un compteur ne peuvent
 * porter. Ce qui est affiché ici est donc vrai, ou n'est pas affiché.
 */
export function phraseHive(stats: {
  aRevoir: number
  actifs: number
  jamaisRappeles: number
  plusVieuxJours: number
}): string {
  if (stats.actifs === 0) {
    return "La mémoire est vide · rien n'a encore été archivé, il n'y a rien à revoir."
  }
  if (stats.aRevoir === 0) {
    return `Rien à revoir · les ${pluriel(stats.actifs, 'savoir')} actifs ont tous été confirmés il y a moins de ${PERIODE_REVUE_JOURS} jours.`
  }
  const tete =
    stats.jamaisRappeles > 0
      ? `${pluriel(stats.jamaisRappeles, 'savoir')} n'${stats.jamaisRappeles > 1 ? 'ont' : 'a'} jamais été rappelé${stats.jamaisRappeles > 1 ? 's' : ''} par un agent`
      : 'tous ont déjà servi au moins une fois'
  return `${pluriel(stats.aRevoir, 'savoir')} à revoir · ${tete}, le plus ancien remonte à ${stats.plusVieuxJours} jours. Je les classe par utilité mesurée, pas par jugement : je ne sais pas lesquels sont faux.`
}

/**
 * La file de la revue : les savoirs actifs qu'aucun humain n'a confirmés depuis
 * un trimestre, les jamais rappelés d'abord, puis les plus anciens.
 */
export async function fileDeRevue(db: Kysely<Database>, now = new Date()): Promise<RevueSavoirs> {
  const seuil = new Date(now.getTime() - PERIODE_REVUE_JOURS * JOUR_MS)

  const lignes = await db
    .selectFrom('savoirs as s')
    // Trois jointures sur la même colonne : `cercle_id` désigne l'une des trois
    // tables selon `cercle`, et `labelCercle` ne lit que celle qui correspond.
    // Une requête par cercle coûterait trois allers-retours pour la même page.
    .leftJoin('projects as p', 'p.id', 's.cercle_id')
    .leftJoin('clients as c', 'c.id', 's.cercle_id')
    .leftJoin('globes as g', 'g.id', 's.cercle_id')
    .select([
      's.racine_id',
      's.version',
      's.cercle',
      's.sujet',
      's.contenu',
      's.rappels',
      's.created_at',
      's.revue_at',
      'p.name as projet_nom',
      'c.name as client_nom',
      'g.name as globe_nom',
    ])
    // `count(*) over ()` est évalué AVANT le `limit` : le total à revoir vient
    // avec la page, sans seconde requête.
    .select(sql<string>`count(*) over ()`.as('total'))
    .where('s.etat', '=', 'actif')
    .where((eb) => eb.or([eb('s.revue_at', 'is', null), eb('s.revue_at', '<', seuil)]))
    .orderBy('s.rappels', 'asc')
    .orderBy('s.created_at', 'asc')
    .limit(LIMITE_FILE)
    .execute()

  const actifsRow = await db
    .selectFrom('savoirs')
    .select(sql<string>`count(*)`.as('n'))
    .where('etat', '=', 'actif')
    .executeTakeFirst()
  const actifs = Number(actifsRow?.n ?? 0)

  const items: SavoirARevoir[] = lignes.map((r) => {
    const createdAt = new Date(r.created_at as unknown as string)
    const revueAt = r.revue_at ? new Date(r.revue_at as unknown as string) : null
    const ageJours = Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / JOUR_MS))
    return {
      racineId: r.racine_id,
      version: r.version,
      cercle: r.cercle,
      cercleLabel: labelCercle(r.cercle, {
        projet: r.projet_nom,
        client: r.client_nom,
        globe: r.globe_nom,
      }),
      sujet: r.sujet,
      contenu: r.contenu,
      rappels: r.rappels,
      ageJours,
      createdAt: createdAt.toISOString(),
      revueAt: revueAt ? revueAt.toISOString() : null,
      pourquoi: pourquoi(r.rappels, ageJours, revueAt),
    }
  })

  const aRevoir = Number(lignes[0]?.total ?? 0)

  return {
    periodeJours: PERIODE_REVUE_JOURS,
    actifs,
    aRevoir,
    hive: phraseHive({
      aRevoir,
      actifs,
      jamaisRappeles: items.filter((i) => i.rappels === 0).length,
      // Le plus ancien de la PAGE, qui est aussi le plus ancien des jamais
      // rappelés : le tri le garantit. Rien n'est extrapolé au-delà.
      plusVieuxJours: items.reduce((max, i) => Math.max(max, i.ageJours), 0),
    }),
    items,
  }
}

/**
 * « Toujours vrai · garder » : le savoir reste actif, sa confirmation est
 * datée. Rend `null` si aucun savoir actif ne porte cette racine — un geste
 * sur un savoir déjà archivé ailleurs ne doit pas passer pour un succès.
 */
export async function garder(
  db: Kysely<Database>,
  racineId: string,
  now = new Date(),
): Promise<Date | null> {
  const ligne = await db
    .updateTable('savoirs')
    .set({ revue_at: now })
    .where('racine_id', '=', racineId)
    .where('etat', '=', 'actif')
    .returning('revue_at')
    .executeTakeFirst()
  return ligne?.revue_at ? new Date(ligne.revue_at as unknown as string) : null
}

/**
 * « Plus d'actualité · archiver » : hors du rappel, historique conservé.
 *
 * L'écriture est celle du magasin (`archiverDefinitivement`) — une seconde
 * façon d'archiver serait une seconde vérité. Ce qu'on ajoute ici est la
 * réponse à « ce savoir existait-il ? », que le magasin ne rend pas et dont la
 * route a besoin pour distinguer un 404 d'un succès.
 */
export async function archiverPerime(db: Kysely<Database>, racineId: string): Promise<boolean> {
  const actif = await db
    .selectFrom('savoirs')
    .select('id')
    .where('racine_id', '=', racineId)
    .where('etat', '=', 'actif')
    .executeTakeFirst()
  if (!actif) return false
  await archiverDefinitivement(db, racineId)
  return true
}

import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { createInboxItem } from '../inbox/repo'
import { type Savoir, archiver } from './store'

/**
 * L'emprunt de savoir entre globes (spec §05) : « l'emprunt, jamais la fuite ».
 *
 * ## Étanches par défaut
 *
 * Un agent d'un globe ne lit JAMAIS le savoir d'un autre. Il demande, et la
 * demande passe par l'inbox comme tout le reste. Le rappel en cascade
 * (`recall.ts`) ne traverse pas les globes : c'est ce qui rend l'étanchéité
 * réelle plutôt que déclarative.
 *
 * ## Ce qui n'est PAS empruntable, et pourquoi c'est structurel
 *
 * Les fiches clients et les secrets, jamais. Ce n'est pas une vérification
 * qu'on aurait pu oublier d'écrire : `emprunts_savoir.savoir_racine_id`
 * référence la table `savoirs`, et **ni les fiches clients ni le coffre n'y
 * vivent**. Emprunter une fiche client n'est pas refusé, c'est inexprimable —
 * le même patron que le cercle d'un autre globe dans le schéma du garant, et
 * que `gmail_send` dans la surface du communicant.
 *
 * ## Deux modes qui ne sont pas des variantes
 *
 * - **`lecture`** : l'emprunteur voit le savoir du prêteur, suit ses
 *   corrections, et le perd si l'emprunt est révoqué. On partage une vérité.
 * - **`fork`** : une copie indépendante est archivée chez l'emprunteur. Elle
 *   survit à la révocation et diverge librement. On prend une photo.
 *
 * Confondre les deux serait grave dans les deux sens : un `fork` révocable
 * ferait disparaître un savoir que l'emprunteur croit sien, et une `lecture`
 * qui survit à la révocation viderait la révocation de son sens.
 */

export const EMPRUNT_INBOX_SUBTYPE = 'emprunt'

export interface DemandeEmprunt {
  globeEmprunteurId: string
  globePreteurId: string
  savoirRacineId: string
  motif?: string | null
  runId?: string | null
}

/**
 * Lève la demande en inbox. Rien n'est accordé ici — c'est le point.
 */
export async function demanderEmprunt(
  db: Kysely<Database>,
  d: DemandeEmprunt,
): Promise<{ id: string }> {
  const savoir = await db
    .selectFrom('savoirs')
    .select(['sujet', 'contenu', 'cercle'])
    .where('racine_id', '=', d.savoirRacineId)
    .where('etat', '=', 'actif')
    .executeTakeFirstOrThrow()

  const globes = await db
    .selectFrom('globes')
    .select(['id', 'name'])
    .where('id', 'in', [d.globeEmprunteurId, d.globePreteurId])
    .execute()
  const nom = (id: string) => globes.find((g) => g.id === id)?.name ?? id

  const item = await createInboxItem(db, {
    type: 'approval',
    subtype: EMPRUNT_INBOX_SUBTYPE,
    fromRole: 'garant',
    title: `Emprunt de savoir · « ${savoir.sujet} »`,
    payload: {
      cause: 'savoir.emprunt',
      ctx: [
        `globe ${nom(d.globeEmprunteurId)} → globe ${nom(d.globePreteurId)}`,
        d.motif ? `Motif : ${d.motif}` : null,
        '',
        'Deux issues, et elles ne durent pas pareil. En LECTURE, le savoir suit les corrections du prêteur et disparaît si vous révoquez. En COPIE, il devient indépendant : il survit à la révocation et suivra sa propre vie.',
      ]
        .filter((l): l is string => l !== null)
        .join('\n'),
      sujet: savoir.sujet,
      contenu: savoir.contenu,
      savoir_racine_id: d.savoirRacineId,
      globe_emprunteur_id: d.globeEmprunteurId,
      globe_preteur_id: d.globePreteurId,
    },
  })
  return { id: item.id }
}

/** Accorde l'emprunt. `fork` archive une copie chez l'emprunteur, `lecture` crée le lien. */
export async function accorderEmprunt(
  db: Kysely<Database>,
  d: DemandeEmprunt,
  mode: 'lecture' | 'fork',
): Promise<void> {
  if (mode === 'fork') {
    const source = await db
      .selectFrom('savoirs')
      .select(['sujet', 'contenu', 'stack'])
      .where('racine_id', '=', d.savoirRacineId)
      .where('etat', '=', 'actif')
      .executeTakeFirstOrThrow()

    // Une COPIE, avec sa propre racine : elle ne suit plus le prêteur et
    // survivra à toute révocation. C'est exactement ce que « fork » veut dire.
    await archiver(db, {
      cercle: 'globe',
      cercleId: d.globeEmprunteurId,
      sujet: source.sujet,
      contenu: source.contenu,
      stack: source.stack,
    })
    return
  }

  await db
    .insertInto('emprunts_savoir')
    .values({
      globe_emprunteur_id: d.globeEmprunteurId,
      globe_preteur_id: d.globePreteurId,
      savoir_racine_id: d.savoirRacineId,
      mode: 'lecture',
      demande_par_run_id: d.runId ?? null,
      motif: d.motif ?? null,
    })
    .execute()
}

/** Révoque un emprunt en lecture. Un fork n'est pas concerné : il n'est plus emprunté, il est possédé. */
export async function revoquerEmprunt(
  db: Kysely<Database>,
  globeEmprunteurId: string,
  savoirRacineId: string,
): Promise<void> {
  await db
    .updateTable('emprunts_savoir')
    .set({ etat: 'revoque', revoked_at: new Date() })
    .where('globe_emprunteur_id', '=', globeEmprunteurId)
    .where('savoir_racine_id', '=', savoirRacineId)
    .where('etat', '=', 'actif')
    .execute()
}

/**
 * Les savoirs qu'un globe voit EN PLUS des siens, par emprunt en lecture.
 *
 * Rendus avec leur version courante côté prêteur : une correction du prêteur
 * se propage, c'est ce qui distingue une lecture d'une copie.
 */
export async function savoirsEmpruntes(
  db: Kysely<Database>,
  globeEmprunteurId: string,
): Promise<Savoir[]> {
  const lignes = await db
    .selectFrom('emprunts_savoir')
    .innerJoin('savoirs', 'savoirs.racine_id', 'emprunts_savoir.savoir_racine_id')
    .select([
      'savoirs.id as id',
      'savoirs.racine_id as racine_id',
      'savoirs.version as version',
      'savoirs.cercle as cercle',
      'savoirs.cercle_id as cercle_id',
      'savoirs.sujet as sujet',
      'savoirs.contenu as contenu',
      'savoirs.stack as stack',
      'savoirs.rappels as rappels',
      'savoirs.created_at as created_at',
    ])
    .where('emprunts_savoir.globe_emprunteur_id', '=', globeEmprunteurId)
    .where('emprunts_savoir.etat', '=', 'actif')
    .where('savoirs.etat', '=', 'actif')
    .execute()

  return lignes.map((l) => ({
    id: l.id,
    racineId: l.racine_id,
    version: l.version,
    cercle: l.cercle,
    cercleId: l.cercle_id,
    sujet: l.sujet,
    contenu: l.contenu,
    stack: l.stack,
    rappels: l.rappels,
    createdAt: new Date(l.created_at as unknown as string),
  }))
}

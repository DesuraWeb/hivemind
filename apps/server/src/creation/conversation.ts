import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { readMajordomeTemplate } from '../hive/conversation'
import type { SondeHttp } from '../ops/types'
import type { RuntimeAdapter } from '../runtime/types'
import { BRIEF_CREATION } from './brief'
import { type Fiche, manquesFiche } from './fiche'
import { createSurfaceCreation } from './outils'
import {
  type Creation,
  type TourCreation,
  cloturerCreation,
  enregistrerTour,
  lireCreation,
} from './repo'

/**
 * Un tour de conversation avec Hive, sur l'écran de création.
 *
 * ## Le motif vient d'`askHive`, et c'est volontaire
 *
 * Le message humain est écrit AVANT l'appel au modèle, et l'historique est
 * rejoué depuis la base à chaque tour plutôt que repris d'une session SDK.
 * Deux conséquences qu'on veut : ce que Florian a tapé n'est jamais perdu si
 * le modèle tombe, et un rafraîchissement d'onglet reprend la conversation
 * sans machinerie de reprise.
 *
 * ## Une panne est un tour du fil
 *
 * Modèle injoignable, budget à sec, outil en échec : la conversation gagne un
 * tour marqué `panne` qui dit ce qui s'est passé. La règle de Florian est
 * d'apprendre un échec depuis l'écran où il se produit, jamais en lisant les
 * logs du serveur — donc l'échec s'affiche là où irait la réplique, et il est
 * persisté comme le reste.
 */

/** Tours rappelés à Hive. Au-delà, le contexte coûte plus qu'il n'aide (même borne qu'`askHive`). */
const LIMITE_HISTORIQUE = 20

export interface TourDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  /** La sonde HTTP, pour vérifier un dépôt ou un staging. */
  http: SondeHttp
  /** Hive n'a aucun accès fichier ici, mais le SDK exige un répertoire. */
  cwd: string
}

export class CreationIntrouvableError extends Error {
  constructor(id: string) {
    super(`création introuvable : ${id}`)
    this.name = 'CreationIntrouvableError'
  }
}

/** L'état de la fiche, redonné à chaque tour : la session est neuve, elle ne s'en souvient pas. */
function etatFiche(fiche: Fiche): string {
  const manques = manquesFiche(fiche)
  return [
    '## La fiche à cet instant',
    JSON.stringify(fiche, null, 2),
    manques.length > 0
      ? `\nIl manque encore : ${manques.join(', ')}.`
      : '\nLa fiche est complète. Propose à Florian de créer, ou challenge une dernière fois.',
  ].join('\n')
}

export interface ResultatTour {
  creation: Creation
  /** Vrai quand le tour de Hive est une panne affichée à l'écran. */
  panne: boolean
}

export async function tourDeCreation(
  deps: TourDeps,
  creationId: string,
  texte: string,
): Promise<ResultatTour> {
  const { db, adapter } = deps

  const avant = await lireCreation(db, creationId)
  if (!avant) throw new CreationIntrouvableError(creationId)

  // Écrit d'abord : si le modèle tombe juste après, ce que Florian a dit est
  // déjà en base et l'écran le réaffiche.
  const humain: TourCreation = { de: 'florian', texte, a: new Date().toISOString() }
  const avecHumain = [...avant.conversation, humain]
  await enregistrerTour(db, creationId, { fiche: avant.fiche, conversation: avecHumain })

  const role = await readMajordomeTemplate(db)
  const surface = createSurfaceCreation({ db, http: deps.http, ficheInitiale: avant.fiche })

  const historique = avecHumain
    .slice(-LIMITE_HISTORIQUE, -1)
    .map((t) => `${t.de === 'florian' ? 'Florian' : 'Toi'} : ${t.texte}`)
    .join('\n')

  try {
    const session = await adapter.createSession({
      roleKey: 'majordome',
      systemPrompt: `${role.systemPrompt}\n\n${BRIEF_CREATION}`,
      cwd: deps.cwd,
      // `web: true` composé ICI et pas dans le seed du majordome : c'est le
      // même rôle qui tient le bandeau HiveStrip, et lui n'a aucune raison
      // d'aller sur le réseau. La recherche sert à vérifier qu'une stack est
      // encore maintenue avant de la proposer.
      tools: { ...role.tools, web: true },
      onEvent: () => {},
    })

    const result = await adapter.send(
      session,
      [
        etatFiche(avant.fiche),
        historique ? `\n## Échanges précédents\n${historique}` : '',
        `\n## Florian vient de dire\n${texte}`,
      ].join('\n'),
      surface.sendOptions,
    )

    // La surface a porté la fiche pendant tout le tour : `proposer_fiche` l'a
    // fait évoluer, et les outils de création ont lu CETTE fiche — c'est ce
    // qui garantit que rien n'est créé qui ne soit passé par l'écran.
    const fiche = surface.fiche()
    const { globeId, projectId } = surface.creations()

    const reponse: TourCreation = {
      de: 'hive',
      texte: result.text,
      a: new Date().toISOString(),
    }
    const apresTour = await enregistrerTour(db, creationId, {
      fiche,
      conversation: [...avecHumain, reponse],
      costTokens: result.costTokens,
    })

    // Ce que ce tour a écrit en base est rattaché à la création : c'est ce qui
    // rend « annuler cette création » trivial, et c'est ce qui rend acceptable
    // qu'un agent écrive sans demander de confirmation.
    const creation =
      globeId || projectId
        ? await cloturerCreation(db, creationId, {
            ...(globeId ? { globeId } : {}),
            ...(projectId ? { projectId } : {}),
            // Tant que le projet n'existe pas, la conversation continue : une
            // orbe créée n'est qu'une étape.
            aboutie: Boolean(projectId),
          })
        : apresTour
    return { creation, panne: false }
  } catch (erreur) {
    // La cause, pas « une erreur est survenue ». Florian doit pouvoir agir
    // depuis l'écran : un budget à sec et un modèle injoignable n'appellent
    // pas la même réaction.
    const cause = erreur instanceof Error ? erreur.message : String(erreur)
    const panne: TourCreation = {
      de: 'hive',
      texte: `Je n'ai pas pu répondre · ${cause}. Ce que tu as écrit est gardé, et la fiche reste modifiable à la main.`,
      a: new Date().toISOString(),
      panne: true,
    }
    const creation = await enregistrerTour(db, creationId, {
      fiche: avant.fiche,
      conversation: [...avecHumain, panne],
    })
    return { creation, panne: true }
  }
}

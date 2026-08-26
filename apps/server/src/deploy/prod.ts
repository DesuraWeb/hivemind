import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import type { OpsExecutor, Serveur, SondeHttp } from '../ops/types'
import type { SettingsStore } from '../settings/store'
import { type AccesCible, resoudreAcces } from './cibles'

/**
 * La mise en production, exécutée après approbation humaine (Lot E).
 *
 * ## Ce que ce fichier ne fait pas
 *
 * Il ne DÉCIDE rien. La décision est prise à l'inbox, sur un gate qui montre
 * ce qui va changer et ce que défaire coûterait. Ici on exécute une décision
 * déjà prise, et le seul pouvoir qu'on garde est celui de REFUSER quand le
 * filet n'est pas là.
 *
 * ## La séquence, et pourquoi elle est dans cet ordre
 *
 * 1. Refuser s'il y a des migrations et aucune commande de sauvegarde. On ne
 *    migre pas à l'aveugle sur un site vivant.
 * 2. Sauvegarder, puis **vérifier la sauvegarde**. Pas « la commande a rendu
 *    0 » : on relit le fichier et on exige qu'il ne soit pas vide. Une
 *    sauvegarde qui a échoué en silence est pire que pas de sauvegarde, parce
 *    qu'elle autorise le geste suivant.
 * 3. Déployer le code.
 * 4. Migrer. En cas d'échec, RESTAURER sans attendre une décision humaine :
 *    demander à un humain pendant qu'une base est à moitié migrée, c'est
 *    laisser le site cassé le temps qu'il lise.
 * 5. Sonder l'URL réelle. « Déployé » ne doit pas vouloir dire « la commande
 *    n'a pas rendu d'erreur ».
 *
 * Le déploiement vient APRÈS la sauvegarde et AVANT la migration : le code
 * neuf doit être en place quand ses migrations tournent, et la sauvegarde doit
 * exister avant que quoi que ce soit ne bouge.
 */

/** Le jeton substitué dans les commandes déclarées. Le code choisit le chemin, donc le code peut vérifier. */
const JETON_FICHIER = '{{fichier}}'

export interface EtapeProd {
  nom:
    | 'sauvegarde'
    | 'verification_sauvegarde'
    | 'deploiement'
    | 'migration'
    | 'restauration'
    | 'sonde'
  ok: boolean
  detail: string
}

export interface ResultatProd {
  ok: boolean
  /** Ce qui a été tenté, dans l'ordre. Lisible même quand tout a réussi. */
  etapes: EtapeProd[]
  /** L'URL sondée, quand on est allé jusque-là. */
  url: string | null
  /** Vrai quand une migration a échoué ET que la restauration a été lancée. */
  restaure: boolean
  raison?: string
}

export interface DeployerProdDeps {
  db: Kysely<Database>
  settings: SettingsStore
  executor: OpsExecutor
  http: SondeHttp
  /** Pousse le code sur la cible. Séparé pour que la séquence soit testable sans SSH ni git. */
  poserLeCode: (
    acces: AccesCible,
    ctx: { runId: string | null; projectSlug: string },
  ) => Promise<{ ok: boolean; detail: string }>
}

export interface DeployerProdInput {
  projectId: string
  /** Les fichiers de migration du step, tels que le gate les a relevés. */
  migrations: string[]
  /** Horodatage du dump, injecté pour que la séquence reste déterministe en test. */
  horodatage: string
  /** De quoi retrouver la branche à pousser. `null` hors d'un run. */
  runId: string | null
  projectSlug: string
}

function serveurDe(acces: AccesCible): Serveur {
  return {
    id: acces.serveurId,
    nom: acces.serveurNom,
    hote: acces.hote,
    utilisateur: acces.utilisateur,
    port: acces.port,
    url: acces.domaine,
    etat: 'en_service',
    sudo: false,
    typeHebergement: acces.typeHebergement as Serveur['typeHebergement'],
    hebergeur: null,
    clientId: null,
    etatMesureAt: null,
    preuves: [],
  }
}

export async function deployerEnProd(
  deps: DeployerProdDeps,
  input: DeployerProdInput,
): Promise<ResultatProd> {
  const etapes: EtapeProd[] = []
  const fin = (ok: boolean, raison?: string, url: string | null = null, restaure = false) =>
    ({ ok, etapes, url, restaure, ...(raison ? { raison } : {}) }) satisfies ResultatProd

  const acces = await resoudreAcces(deps.db, deps.settings, input.projectId, 'prod')
  if (!acces) {
    return fin(false, "aucune cible de production configurée pour ce projet · rien n'a été tenté")
  }

  const serveur = serveurDe(acces)
  const aMigrer = input.migrations.length > 0

  // Le filet, ou rien. Une cible sans commande de sauvegarde ne reçoit pas de
  // migration : refuser ici est le comportement voulu, pas une limitation.
  if (aMigrer && !acces.commandeSauvegarde?.trim()) {
    return fin(
      false,
      `${input.migrations.length} migration(s) dans ce step et aucune commande de sauvegarde déclarée sur la cible · on ne migre pas sans filet`,
    )
  }

  const fichier = `${acces.chemin}/.silithid-sauvegarde-${input.horodatage}.sql`

  if (aMigrer && acces.commandeSauvegarde) {
    const cmd = acces.commandeSauvegarde.replaceAll(JETON_FICHIER, fichier)
    const r = await deps.executor.executer(serveur, cmd)
    etapes.push({
      nom: 'sauvegarde',
      ok: r.code === 0,
      detail: r.code === 0 ? `dump écrit dans ${fichier}` : r.stderr.trim() || `code ${r.code}`,
    })
    if (r.code !== 0) return fin(false, 'sauvegarde échouée · rien n’a été déployé ni migré')

    // Le point qui compte : on RELIT le fichier. `test -s` échoue s'il est
    // absent ou vide. Une commande qui rend 0 en écrivant zéro octet existe,
    // et c'est exactement le cas qui ferait migrer sans filet.
    const v = await deps.executor.executer(serveur, `test -s ${fichier}`)
    etapes.push({
      nom: 'verification_sauvegarde',
      ok: v.code === 0,
      detail: v.code === 0 ? 'dump non vide' : 'dump absent ou vide',
    })
    if (v.code !== 0) {
      return fin(false, 'la sauvegarde est vide ou absente · rien n’a été déployé ni migré')
    }
  }

  const pose = await deps.poserLeCode(acces, {
    runId: input.runId,
    projectSlug: input.projectSlug,
  })
  etapes.push({ nom: 'deploiement', ok: pose.ok, detail: pose.detail })
  if (!pose.ok) return fin(false, `déploiement échoué · ${pose.detail}`)

  if (aMigrer && acces.commandeMigration?.trim()) {
    const m = await deps.executor.executer(serveur, acces.commandeMigration)
    etapes.push({
      nom: 'migration',
      ok: m.code === 0,
      detail: m.code === 0 ? 'schéma migré' : m.stderr.trim() || `code ${m.code}`,
    })

    if (m.code !== 0) {
      // Restaurer TOUT DE SUITE, sans attendre une décision. Demander à un
      // humain pendant qu'une base est à moitié migrée, c'est laisser le site
      // cassé le temps qu'il lise son inbox.
      if (!acces.commandeRestauration?.trim()) {
        return fin(
          false,
          'migration échouée et aucune commande de restauration déclarée · la base est dans un état intermédiaire, intervention manuelle requise',
        )
      }
      const cmd = acces.commandeRestauration.replaceAll(JETON_FICHIER, fichier)
      const r = await deps.executor.executer(serveur, cmd)
      etapes.push({
        nom: 'restauration',
        ok: r.code === 0,
        detail: r.code === 0 ? `restauré depuis ${fichier}` : r.stderr.trim() || `code ${r.code}`,
      })
      return fin(
        false,
        r.code === 0
          ? 'migration échouée · base restaurée depuis la sauvegarde vérifiée'
          : 'migration échouée ET restauration échouée · intervention manuelle immédiate',
        null,
        r.code === 0,
      )
    }
  }

  // Lot G · vérifier après. Sans cette sonde, « déployé » veut dire « la
  // commande n'a pas rendu d'erreur », ce qui n'est pas la même chose — et on
  // l'apprendrait par un client.
  const url = acces.domaine ? `https://${acces.domaine}` : null
  if (url) {
    const s = await deps.http(url)
    const vivant = 'statut' in s && s.statut >= 200 && s.statut < 400
    etapes.push({
      nom: 'sonde',
      ok: vivant,
      detail: 'statut' in s ? `HTTP ${s.statut}` : s.erreur,
    })
    if (!vivant) {
      return fin(false, `le site ne répond pas après déploiement · ${etapes.at(-1)?.detail}`, url)
    }
  }

  return fin(true, undefined, url)
}

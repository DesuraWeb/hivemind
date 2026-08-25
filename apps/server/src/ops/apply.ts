import { sh } from '../integrations/ssh'
import {
  type CommandeRendue,
  type Operation,
  type OptionsRendu,
  rendre,
  valider,
} from './operations'
import type { OpsExecutor, Serveur } from './types'

/**
 * L'exécution d'une suite d'opérations, et son arrêt au premier échec.
 *
 * ## L'arrêt immédiat n'est pas de la prudence, c'est la seule issue sûre
 *
 * Un serveur à moitié configuré est plus dangereux qu'un serveur pas
 * configuré, parce que personne ne sait dans quel état il est. Donc : dès
 * qu'une opération échoue, on s'arrête, et on rend l'état exact atteint — ce
 * qui a été appliqué, ce qui ne l'a pas été, et où sont les sauvegardes.
 *
 * **Aucune reprise automatique**, et aucun retour arrière automatique non
 * plus. Défaire ce qui vient d'être fait, sans savoir pourquoi la suite a
 * échoué, c'est une deuxième intervention non validée sur un serveur déjà
 * instable. Les inverses sont donnés à l'humain, ils ne s'exécutent pas seuls.
 *
 * ## Une opération, un aller-retour
 *
 * Contrairement au déploiement (`deploy/ssh-git.ts`, un seul script d'un
 * bloc), chaque opération part séparément. C'est plus lent et c'est le but :
 * un script d'un bloc avec `set -e` s'arrête aussi au premier échec, mais on
 * ne saurait pas LAQUELLE a échoué ni ce qui avait déjà passé. Ici, on le sait
 * exactement.
 */

export interface OperationAppliquee {
  nom: string
  resume: string
  commande: string
  sauvegarde: string | null
  inverse: string | null
  code: number
  /** Sortie standard, tronquée : elle finit dans un item d'inbox, pas dans un terminal. */
  sortie: string
  erreur: string
}

export interface ResultatApplication {
  ok: boolean
  appliquees: OperationAppliquee[]
  /** Ce qui n'a pas été tenté, parce qu'on s'est arrêté avant. Nommé, jamais deviné. */
  nonTentees: string[]
  /** Présent seulement en échec : ce que l'humain doit lire en premier. */
  echec?: {
    nom: string
    code: number
    erreur: string
    /** Les inverses des opérations DÉJÀ appliquées, dans l'ordre inverse. Jamais exécutés ici. */
    retourArriere: string[]
    /** Les opérations appliquées qui ne se défont pas. Le vrai risque, nommé. */
    irreversibles: string[]
  }
}

const MAX_SORTIE = 4000

/**
 * `inverse` porte trois choses différentes, et les confondre serait grave :
 * une vraie commande, `null` (« ça ne se défait pas »), ou « sans objet · … »
 * (« il n'y a rien à défaire », cas d'une lecture ou d'un rechargement).
 *
 * Seule la première est exécutable. Faire figurer « sans objet · une lecture
 * ne modifie rien » dans une liste de commandes à taper serait au mieux
 * déroutant, au pire copié-collé dans un terminal.
 */
function estCommandeInverse(inverse: string | null): inverse is string {
  return typeof inverse === 'string' && !inverse.startsWith('sans objet')
}

export interface AppliquerDeps {
  executor: OpsExecutor
  serveur: Serveur
}

/**
 * Valide TOUT le plan avant d'exécuter la première ligne.
 *
 * Un plan à moitié valide n'existe pas : découvrir à la quatrième opération
 * qu'elle est hors catalogue laisserait trois modifications appliquées pour
 * rien.
 */
export function validerPlan(operations: Operation[]): { ok: true } | { ok: false; raison: string } {
  for (const [i, op] of operations.entries()) {
    const v = valider(op)
    if (!v.ok) return { ok: false, raison: `opération ${i + 1}/${operations.length} · ${v.raison}` }
  }
  return { ok: true }
}

/** Rend toutes les commandes d'un plan, dans l'ordre. Ce que Florian lit avant d'approuver. */
export function rendrePlan(operations: Operation[], opts: OptionsRendu = {}): CommandeRendue[] {
  const v = validerPlan(operations)
  if (!v.ok) throw new Error(v.raison)
  // `.map(rendre)` passerait l'INDEX en second argument, donc un nombre là où
  // les options sont attendues. Explicite, du coup.
  return operations.map((op) => rendre(op, opts))
}

export async function appliquer(
  deps: AppliquerDeps,
  operations: Operation[],
): Promise<ResultatApplication> {
  const v = validerPlan(operations)
  if (!v.ok) throw new Error(v.raison)

  const appliquees: OperationAppliquee[] = []

  for (const [i, op] of operations.entries()) {
    // L'élévation vient du SERVEUR, pas de l'appelant : c'est une propriété du
    // compte SSH, et la laisser choisir ailleurs permettrait d'exécuter sans
    // sudo sur une machine qui en a besoin, ou l'inverse.
    const rendu = rendre(op, { sudo: deps.serveur.sudo })
    // `set -e` sur une opération multi-lignes (écriture avec sauvegarde) :
    // sans lui, une sauvegarde qui échoue laisserait l'écriture se faire quand
    // même — exactement le cas où le retour arrière disparaît en silence.
    const script = `set -e\n${rendu.commande}`

    let code = -1
    let sortie = ''
    let erreur = ''
    try {
      const r = await deps.executor.executer(deps.serveur, script)
      code = r.code
      sortie = r.stdout.slice(0, MAX_SORTIE)
      erreur = r.stderr.slice(0, MAX_SORTIE)
    } catch (err) {
      erreur = err instanceof Error ? err.message : String(err)
    }

    appliquees.push({
      nom: op.nom,
      resume: rendu.resume,
      commande: rendu.commande,
      sauvegarde: rendu.sauvegarde,
      inverse: rendu.inverse,
      code,
      sortie,
      erreur,
    })

    if (code !== 0) {
      const faites = appliquees.slice(0, -1)
      return {
        ok: false,
        appliquees,
        nonTentees: operations.slice(i + 1).map((o) => o.nom),
        echec: {
          nom: op.nom,
          code,
          erreur: erreur || `code ${code}`,
          // Ordre inverse : on défait la dernière modification en premier.
          // Donnés, jamais exécutés — défaire sans savoir pourquoi la suite a
          // échoué serait une deuxième intervention non validée.
          retourArriere: faites
            .map((a) => a.inverse)
            .filter(estCommandeInverse)
            .reverse(),
          irreversibles: faites.filter((a) => a.inverse === null).map((a) => a.resume),
        },
      }
    }
  }

  return { ok: true, appliquees, nonTentees: [] }
}

/**
 * Un texte lisible de ce qui s'est passé, pour l'item d'inbox et le journal.
 *
 * Le format est fait pour être relu six semaines plus tard par quelqu'un qui
 * ne se souvient de rien : ce qui a marché, ce qui a cassé, où sont les
 * sauvegardes, et ce qui ne se défait pas.
 */
export function raconter(resultat: ResultatApplication, serveur: Serveur): string {
  const lignes = [`Serveur ${serveur.nom} (${serveur.hote})`, '']

  for (const a of resultat.appliquees) {
    lignes.push(`${a.code === 0 ? '✓' : '✗'} ${a.resume}`)
    if (a.sauvegarde) lignes.push(`   sauvegarde · ${a.sauvegarde}`)
    if (a.code !== 0 && a.erreur) lignes.push(`   erreur · ${a.erreur.split('\n')[0]}`)
  }

  if (resultat.echec) {
    lignes.push(
      '',
      `Arrêt sur « ${resultat.echec.nom} ». Rien de ce qui suivait n'a été tenté${
        resultat.nonTentees.length > 0 ? ` : ${resultat.nonTentees.join(', ')}` : ''
      }.`,
    )
    if (resultat.echec.irreversibles.length > 0) {
      lignes.push('', `Ne se défait pas : ${resultat.echec.irreversibles.join(' · ')}`)
    }
    if (resultat.echec.retourArriere.length > 0) {
      lignes.push(
        '',
        'Pour revenir en arrière, à exécuter dans cet ordre :',
        ...resultat.echec.retourArriere.map((c) => `   ${c}`),
      )
    }
  }

  return lignes.join('\n')
}

/** Réexporté pour les appelants qui composent un script à la main (la sonde). */
export { sh }

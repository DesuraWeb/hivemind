import { runSshScript } from '../integrations/ssh'
import type { SettingsStore } from '../settings/store'
import { lireAcces } from './credentials'
import type { OpsExecutor, SondeHttp } from './types'

/**
 * L'exécuteur réel : ce qui parle vraiment aux serveurs.
 *
 * Isolé dans son propre fichier, derrière le contrat `OpsExecutor`, pour une
 * raison très concrète : tout le reste de l'exploitation (la sonde, le plan de
 * changement, l'exécution après approbation) doit être testable sans un
 * serveur à casser. Un test qui exigerait un vrai VPS ne serait jamais écrit.
 *
 * L'accès est relu à CHAQUE appel, depuis le coffre, avec la portée du serveur
 * visé. Pas de cache : une clé mémorisée survivrait à sa révocation, et un
 * accès qu'on croit retiré mais qui fonctionne encore est le pire des deux
 * mondes.
 */
export function createSshExecutor(settings: SettingsStore): OpsExecutor {
  return {
    kind: 'ssh',
    async executer(serveur, script) {
      const acces = await lireAcces(settings, serveur.nom)
      return runSshScript(
        {
          hote: serveur.hote,
          utilisateur: serveur.utilisateur,
          port: serveur.port,
          clePrivee: acces.clePrivee,
        },
        script,
      )
    },
  }
}

/**
 * La sonde HTTP réelle.
 *
 * `redirect: 'manual'` : une redirection est déjà une réponse, et la suivre
 * pourrait nous emmener sur un autre hôte — dont l'état ne dit rien de celui
 * qu'on mesure.
 *
 * Le délai est court et l'erreur remonte telle quelle : c'est `preuveHttp`
 * (probe.ts) qui décide si « rien n'écoute » ou « on ne sait pas », et cette
 * distinction dépend du texte exact de l'erreur.
 */
export function createSondeHttp(timeoutMs = 5000): SondeHttp {
  return async (url) => {
    const controleur = new AbortController()
    const minuterie = setTimeout(() => controleur.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controleur.signal,
      })
      return { statut: res.status }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Un abandon est un délai dépassé, pas un refus : le distinguer ici
      // évite qu'un pare-feu lent passe pour un serveur éteint.
      return { erreur: controleur.signal.aborted ? `timeout ${timeoutMs}ms` : message }
    } finally {
      clearTimeout(minuterie)
    }
  }
}

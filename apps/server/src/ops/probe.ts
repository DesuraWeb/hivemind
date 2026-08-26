import type { EtatServeur } from '@silithid/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { sh } from '../integrations/ssh'
import type { OpsExecutor, PreuveSonde, Serveur, SondeHttp, VerdictPreuve } from './types'

/**
 * La sonde d'état : « vierge » se MESURE, il ne se déclare pas.
 *
 * ## Ce qui est en jeu
 *
 * L'autonomie de l'agent d'exploitation dépend entièrement de ce verdict. Sur
 * un serveur `vierge` il enchaîne les opérations sans validation intermédiaire
 * — il n'y a rien à casser. Se tromper ici, c'est donner le champ libre sur un
 * serveur qui héberge le site d'un client. C'est, de tout le système, l'erreur
 * la plus chère : elle ne se rattrape pas par un `git revert`.
 *
 * D'où la règle qui gouverne tout le fichier : **en cas de doute,
 * `en_service`**. Se tromper vers la prudence coûte une validation de plus ;
 * se tromper vers le champ libre coûte un site client. Les deux erreurs n'ont
 * pas le même prix, donc elles n'ont pas droit au même traitement.
 *
 * ## La sonde porte sur la MACHINE, pas sur un répertoire
 *
 * Un répertoire vide ne prouve rien : le site peut vivre ailleurs sur la même
 * machine. C'est exactement le cas du VPS de Florian — six vhosts nginx
 * (reparea.fr, desura.fr, manager.desura.fr…), une base MySQL mutualisée. Un
 * répertoire neuf y serait vide, et la machine n'a rien de vierge.
 *
 * Conséquence assumée : **le VPS de Florian ne sera jamais `vierge`**, et
 * c'est le bon résultat. Le champ libre est fait pour un hébergement neuf
 * qu'on vient d'acheter, pas pour une machine qui sert déjà.
 *
 * ## Les cinq preuves, et pourquoi celles-là
 *
 * - `http` — quelque chose répond-il sur l'URL publique ? Preuve la plus
 *   directe, et la seule qui ne passe pas par SSH : un serveur peut refuser
 *   notre clé et servir parfaitement un site.
 * - `vhosts` — le serveur web a-t-il des hôtes virtuels configurés au-delà du
 *   défaut ? C'est ce qui rattrape « le site vit ailleurs sur la machine ».
 * - `fichiers` — les racines web habituelles contiennent-elles autre chose que
 *   la page d'accueil du paquet ?
 * - `bases` — existe-t-il une base autre que celles du système ?
 * - `journaux` — les journaux d'accès portent-ils des lignes récentes ? Du
 *   trafic est la preuve qu'on ne peut pas contester : quelqu'un s'en sert.
 *
 * Une seule qui dit `occupe` suffit à conclure `en_service`. Une seule qui dit
 * `inconnu` suffit aussi : ne pas savoir n'est pas savoir que c'est vide.
 */

/** Racines web habituelles. Ni exhaustif ni configurable : c'est un faisceau, pas un inventaire. */
const RACINES_WEB = ['/var/www', '/srv/www', '/usr/share/nginx/html', '/home/*/public_html']

/** Répertoires de configuration d'hôtes virtuels, nginx et apache. */
const CONFIGS_VHOSTS = [
  '/etc/nginx/sites-enabled',
  '/etc/nginx/conf.d',
  '/etc/apache2/sites-enabled',
  '/etc/httpd/conf.d',
]

const JOURNAUX_ACCES = ['/var/log/nginx/access.log', '/var/log/apache2/access.log']

/** Nombre de jours en deçà duquel une ligne de journal compte comme « du trafic récent ». */
const FENETRE_TRAFIC_JOURS = 30

/**
 * Le script de sonde. **Lecture seule, intégralement** : `ls`, `find`, `test`.
 * Aucune écriture, aucune installation, aucun rechargement de service. Une
 * sonde qui modifierait le serveur qu'elle mesure serait déjà une intervention.
 *
 * Pas de `set -e` : ici, contrairement au déploiement, on VEUT que chaque
 * bloc s'exécute même si le précédent échoue. Un serveur sans nginx n'est pas
 * une panne de sonde, c'est une preuve de moins.
 *
 * Chaque bloc écrit une ligne `nom=valeur`. Le format est plat volontairement :
 * du JSON généré en shell casserait au premier chemin exotique.
 */
export function scriptDeSonde(): string {
  const racines = RACINES_WEB.map(sh).join(' ')
  const vhosts = CONFIGS_VHOSTS.map(sh).join(' ')
  const journaux = JOURNAUX_ACCES.map(sh).join(' ')

  return [
    // Hôtes virtuels : on compte les fichiers, en écartant les défauts posés
    // par les paquets. Un `default` seul ne prouve pas qu'un site est servi.
    `echo "vhosts=$(for d in ${vhosts}; do [ -d "$d" ] && ls -1 "$d" 2>/dev/null; done | grep -v -x -e default -e default.conf -e 000-default.conf -e welcome.conf | wc -l | tr -d ' ')"`,
    // Fichiers : on cherche un fichier ordinaire quelconque, en écartant les
    // pages d'accueil que les paquets déposent eux-mêmes.
    `echo "fichiers=$(for d in ${racines}; do [ -d "$d" ] && find "$d" -maxdepth 3 -type f ! -name 'index.nginx-debian.html' ! -name 'index.html' 2>/dev/null; done | head -50 | wc -l | tr -d ' ')"`,
    // Bases : MySQL et PostgreSQL, en écartant les schémas système. Une
    // connexion refusée écrit une ligne vide, donc `inconnu` — jamais « vide ».
    `echo "bases_mysql=$(mysql -N -B -e 'show databases' 2>/dev/null | grep -v -x -e information_schema -e performance_schema -e mysql -e sys | wc -l | tr -d ' ')"`,
    `echo "bases_pg=$(psql -tAc 'select count(*) from pg_database where not datistemplate and datname <> '"'"'postgres'"'"'' 2>/dev/null | tr -d ' ')"`,
    // Trafic : une ligne de journal modifiée récemment. `-mtime -N` répond à
    // « quelqu'un s'en sert », ce qu'aucune autre preuve ne montre.
    `echo "journaux=$(for f in ${journaux}; do [ -f "$f" ] && find "$f" -mtime -${FENETRE_TRAFIC_JOURS} -size +0 2>/dev/null; done | wc -l | tr -d ' ')"`,
    // Marqueur de fin : sa présence prouve que le script est allé au bout.
    // Sans lui, une connexion coupée au milieu rendrait des compteurs à zéro
    // qu'on lirait comme « vide ».
    'echo "sonde=complete"',
  ].join('\n')
}

/** Parse les lignes `nom=valeur` du script. Tolérant : ce qui manque devient absent, pas zéro. */
function lireSortie(stdout: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const ligne of stdout.split('\n')) {
    const index = ligne.indexOf('=')
    if (index <= 0) continue
    map.set(ligne.slice(0, index).trim(), ligne.slice(index + 1).trim())
  }
  return map
}

/**
 * Un compteur devient une preuve.
 *
 * Absent ou non numérique → `inconnu`. C'est le cas d'un serveur sans nginx,
 * sans MySQL, ou dont la commande n'existe pas : on ne sait pas, et ne pas
 * savoir n'est pas savoir que c'est vide.
 */
function preuveDeCompteur(nom: string, brut: string | undefined, quandOccupe: string): PreuveSonde {
  if (brut === undefined || brut === '' || !/^\d+$/.test(brut)) {
    return { nom, verdict: 'inconnu', detail: 'la mesure n’a rien rendu de lisible' }
  }
  const n = Number(brut)
  return n > 0
    ? { nom, verdict: 'occupe', detail: `${quandOccupe} : ${n}` }
    : { nom, verdict: 'vide', detail: 'aucun' }
}

/**
 * La preuve HTTP.
 *
 * Un refus de connexion ou un nom qui ne résout pas est une preuve de VIDE :
 * rien n'écoute, rien n'est publié. Un délai dépassé, en revanche, est
 * `inconnu` — un pare-feu qui nous ignore ressemble en tout point à un serveur
 * éteint, et les deux n'ont pas les mêmes conséquences.
 *
 * Un 404 compte comme OCCUPÉ : quelque chose sert le HTTP, et ce quelque chose
 * a une configuration qu'on ne connaît pas.
 */
export function preuveHttp(reponse: { statut: number } | { erreur: string }): PreuveSonde {
  if ('statut' in reponse) {
    return {
      nom: 'http',
      verdict: 'occupe',
      detail: `l’URL répond (HTTP ${reponse.statut})`,
    }
  }
  const erreur = reponse.erreur.toUpperCase()
  if (erreur.includes('ECONNREFUSED') || erreur.includes('ENOTFOUND')) {
    return { nom: 'http', verdict: 'vide', detail: `rien n’écoute (${reponse.erreur})` }
  }
  return {
    nom: 'http',
    verdict: 'inconnu',
    detail: `impossible de conclure (${reponse.erreur}) — un pare-feu ressemble à un serveur éteint`,
  }
}

/**
 * Le verdict, à partir des preuves. Fonction pure : c'est elle qui porte la
 * règle du doute, et elle se teste sans serveur ni base.
 */
export function verdictDepuisPreuves(preuves: PreuveSonde[]): {
  etat: Exclude<EtatServeur, 'inconnu'>
  raison: string
} {
  if (preuves.length === 0) {
    return { etat: 'en_service', raison: 'aucune preuve recueillie' }
  }

  const occupees = preuves.filter((p) => p.verdict === 'occupe')
  if (occupees.length > 0) {
    return {
      etat: 'en_service',
      raison: `quelque chose vit ici · ${occupees.map((p) => p.nom).join(', ')}`,
    }
  }

  const douteuses = preuves.filter((p) => p.verdict === 'inconnu')
  if (douteuses.length > 0) {
    // Le cœur de la sonde. Le champ libre exige de savoir, pas de ne rien voir.
    return {
      etat: 'en_service',
      raison: `mesure incomplète · ${douteuses.map((p) => p.nom).join(', ')} n’ont rien pu établir`,
    }
  }

  return { etat: 'vierge', raison: `${preuves.length} preuves, toutes vides` }
}

export interface SonderDeps {
  db: Kysely<Database>
  executor: OpsExecutor
  http: SondeHttp
}

export interface ResultatSonde {
  etat: EtatServeur
  raison: string
  preuves: PreuveSonde[]
  /** `true` si le verdict mesuré a été ignoré parce que le serveur était déjà en service. */
  figee: boolean
}

/**
 * Sonde un serveur et persiste le verdict.
 *
 * Le sens unique est déjà garanti par un trigger (migration 0011) : cette
 * fonction ne se contente pas de ne pas essayer, elle CONSTATE l'état courant
 * et rend `figee: true` quand la mesure est plus optimiste que l'histoire.
 * Deux garde-fous plutôt qu'un, parce que celui du schéma ne dit pas pourquoi.
 */
export async function sonder(deps: SonderDeps, serveurId: string): Promise<ResultatSonde> {
  const serveur = await lireServeur(deps.db, serveurId)

  const preuves: PreuveSonde[] = []

  if (serveur.url) {
    preuves.push(preuveHttp(await deps.http(serveur.url)))
  } else {
    // Pas d'URL, pas de preuve HTTP — et cette absence est elle-même une
    // incertitude, pas un vide. Elle suffit à interdire le champ libre.
    preuves.push({
      nom: 'http',
      verdict: 'inconnu',
      detail: 'aucune URL publique enregistrée pour ce serveur',
    })
  }

  try {
    const { code, stdout } = await deps.executor.executer(serveur, scriptDeSonde())
    const valeurs = lireSortie(stdout)

    if (code !== 0 || valeurs.get('sonde') !== 'complete') {
      preuves.push({
        nom: 'shell',
        verdict: 'inconnu',
        detail: `la sonde n’est pas allée au bout (code ${code})`,
      })
    } else {
      preuves.push(preuveDeCompteur('vhosts', valeurs.get('vhosts'), 'hôtes virtuels configurés'))
      preuves.push(preuveDeCompteur('fichiers', valeurs.get('fichiers'), 'fichiers servis'))
      preuves.push(preuveBases(valeurs))
      preuves.push(
        preuveDeCompteur(
          'journaux',
          valeurs.get('journaux'),
          `journaux d’accès actifs sur ${FENETRE_TRAFIC_JOURS} j`,
        ),
      )
    }
  } catch (err) {
    preuves.push({
      nom: 'shell',
      verdict: 'inconnu',
      detail: `connexion impossible : ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  const mesure = verdictDepuisPreuves(preuves)
  const figee = serveur.etat === 'en_service' && mesure.etat !== 'en_service'
  const etat: EtatServeur = figee ? 'en_service' : mesure.etat
  const raison = figee
    ? `déjà en service · la mesure disait « ${mesure.etat} », un serveur en service ne redevient jamais vierge`
    : mesure.raison

  await deps.db
    .updateTable('serveurs')
    .set({
      etat,
      etat_mesure_at: new Date(),
      etat_preuves: JSON.stringify(preuves),
    })
    .where('id', '=', serveurId)
    .execute()

  return { etat, raison, preuves, figee }
}

/**
 * Les deux moteurs de base fusionnés en une preuve.
 *
 * L'un des deux suffit à occuper la machine. Aucun des deux lisible : on ne
 * sait pas, on ne conclut pas au vide. Un serveur qui n'a NI mysql NI psql
 * installés rend deux mesures illisibles — et c'est justement le cas d'un
 * hébergement neuf, d'où l'importance des quatre autres preuves.
 */
function preuveBases(valeurs: Map<string, string>): PreuveSonde {
  const mysql = valeurs.get('bases_mysql')
  const pg = valeurs.get('bases_pg')
  const lisibles = [mysql, pg].filter((v) => v !== undefined && v !== '' && /^\d+$/.test(v))

  if (lisibles.length === 0) {
    return {
      nom: 'bases',
      verdict: 'inconnu',
      detail: 'ni MySQL ni PostgreSQL n’ont répondu — absents, ou inaccessibles à cet utilisateur',
    }
  }

  const total = lisibles.reduce((sum, v) => sum + Number(v), 0)
  return total > 0
    ? { nom: 'bases', verdict: 'occupe', detail: `bases applicatives : ${total}` }
    : { nom: 'bases', verdict: 'vide', detail: 'aucune base applicative' }
}

export async function lireServeur(db: Kysely<Database>, id: string): Promise<Serveur> {
  const row = await db
    .selectFrom('serveurs')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()

  return {
    id: row.id,
    nom: row.nom,
    hote: row.hote,
    utilisateur: row.utilisateur,
    port: row.port,
    url: row.url,
    etat: row.etat,
    sudo: row.sudo,
    typeHebergement: row.type_hebergement as Serveur['typeHebergement'],
    hebergeur: row.hebergeur,
    clientId: row.client_id,
    etatMesureAt: row.etat_mesure_at ? new Date(row.etat_mesure_at as unknown as string) : null,
    preuves: Array.isArray(row.etat_preuves) ? (row.etat_preuves as PreuveSonde[]) : [],
  }
}

/** Le verdict d'une preuve, exporté pour les tests qui composent des faisceaux. */
export type { VerdictPreuve }

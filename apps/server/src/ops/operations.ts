import { z } from 'zod'
import { sh } from '../integrations/ssh'

/**
 * Le catalogue borné : tout ce que l'agent d'exploitation sait faire, et rien
 * d'autre.
 *
 * ## Pourquoi un catalogue plutôt qu'un shell
 *
 * Un agent à qui on donne `bash` a tous les droits, quels que soient les mots
 * du prompt. C'est le constat de la Phase 1 et il ne s'améliore pas en
 * changeant de serveur — au contraire : ici la machine n'est pas un worktree
 * jetable, c'est le serveur d'un client.
 *
 * Il n'existe donc **aucune opération `shell`, `exec`, `run` ou équivalent**.
 * Pas de trappe d'échappement, pas de « juste pour ce cas-là ». C'est ce que
 * `ops-catalogue.test.ts` vérifie par énumération, pas par relecture.
 *
 * ## Ce qui se passe quand une tâche n'entre pas dans le catalogue
 *
 * Elle sort en PROPOSITION (`PropositionHorsCatalogue`), pas en échec. C'est
 * le principal signal de croissance du catalogue : l'agent dit ce qu'il ferait
 * et pourquoi, Florian valide une fois, et ça devient une opération. Sans
 * cette voie, l'agent apprend à se taire — et un agent qui se tait sur ce
 * qu'il ne peut pas faire est pire qu'un agent qui échoue.
 *
 * **Le catalogue est un cliquet, jamais un plafond, et il ne se remplit
 * jamais tout seul.** C'est la ligne à ne pas franchir de toute la phase : le
 * savoir s'accumule sans intervention (les recettes par stack), le POUVOIR ne
 * s'élargit que par une décision humaine et un commit.
 *
 * ## Trois choses que chaque opération doit savoir dire
 *
 * 1. **Sa commande exacte**, en texte, avant de l'exécuter. C'est ce texte qui
 *    est montré à Florian, et c'est exactement ce qui s'exécutera.
 * 2. **Sa sauvegarde préalable**, quand elle touche quelque chose d'existant.
 *    Le retour arrière est capturé AVANT, jamais prévu après.
 * 3. **Son inverse — ou l'aveu qu'il n'y en a pas.** Une opération sans retour
 *    arrière doit se signaler comme telle plutôt que de laisser croire.
 */

/** Où atterrissent les sauvegardes. Horodaté : deux passages ne s'écrasent pas. */
const RACINE_SAUVEGARDES = '/var/backups/silithid'

const cheminSchema = z
  .string()
  .min(1)
  .max(4096)
  // Chemin absolu, sans remontée. Ce n'est pas de la paranoïa d'entrée : un
  // `..` dans un chemin de configuration transforme « écrire un vhost » en
  // « écrire n'importe où », et c'est l'agent qui fournit ce chemin.
  .refine((v) => v.startsWith('/'), 'le chemin doit être absolu')
  .refine((v) => !v.split('/').includes('..'), 'aucune remontée de répertoire')

/**
 * Nom de paquet, de service ou d'extension. Volontairement étroit : ce qui
 * n'entre pas dans cette forme n'est pas un nom, c'est une tentative.
 */
const nomSystemeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/, 'nom système invalide')

export const OPERATIONS_SCHEMAS = {
  lire_fichier: z.object({ chemin: cheminSchema }),
  ecrire_fichier: z.object({
    chemin: cheminSchema,
    contenu: z.string().max(256 * 1024),
    /** Permissions octales, ex. `644`. Absent, on ne touche pas au mode existant. */
    mode: z
      .string()
      .regex(/^[0-7]{3,4}$/)
      .optional(),
  }),
  installer_paquet: z.object({ paquet: nomSystemeSchema }),
  activer_extension_php: z.object({ extension: nomSystemeSchema }),
  recharger_service: z.object({ service: nomSystemeSchema }),
  poser_cron: z.object({
    /** Nom du fichier dans `/etc/cron.d`. Pas de chemin : c'est le répertoire qui est fixe. */
    nom: nomSystemeSchema,
    /** Cinq champs cron, un utilisateur, une commande. Validé côté serveur, pas seulement rappelé. */
    planification: z.string().min(9).max(200),
    utilisateur: nomSystemeSchema,
    commande: z.string().min(1).max(2000),
  }),
} as const

export type NomOperation = keyof typeof OPERATIONS_SCHEMAS

export const NOMS_OPERATIONS = Object.keys(OPERATIONS_SCHEMAS) as NomOperation[]

/**
 * Mots dont la présence dans un nom d'opération signalerait une trappe
 * d'échappement. Testé par énumération sur le catalogue : ce n'est pas une
 * relecture, c'est une garantie qui casse le jour où quelqu'un ajoute
 * `executer_commande`.
 */
export const MOTS_INTERDITS = ['shell', 'exec', 'run', 'commande', 'bash', 'sh', 'eval', 'script']

export interface Operation {
  nom: NomOperation
  params: Record<string, unknown>
}

export interface CommandeRendue {
  /** Ce qui s'exécutera, en texte. Montré à Florian tel quel. */
  commande: string
  /**
   * Ce qu'on sauvegarde AVANT, s'il y a lieu. `null` quand l'opération ne
   * touche rien d'existant (installer un paquet ne détruit pas de fichier).
   */
  sauvegarde: string | null
  /**
   * Comment revenir en arrière. `null` est une réponse LÉGITIME et lourde de
   * sens : elle veut dire « cette opération ne se défait pas », et l'item
   * d'inbox doit le dire à Florian avant qu'il approuve.
   */
  inverse: string | null
  /** Ce que ça fait, en français, pour quelqu'un qui ne lit pas la commande. */
  resume: string
}

/**
 * Une tâche que le catalogue ne couvre pas.
 *
 * Résultat de premier rang, pas un échec : c'est ainsi que le catalogue
 * grandit. L'agent décrit ce qu'il ferait ; personne ne l'exécute.
 */
export interface PropositionHorsCatalogue {
  /** Nom qu'aurait l'opération si elle existait. Sert à en discuter. */
  nomPropose: string
  /** Ce qu'elle ferait, et pourquoi ce projet en a besoin. */
  besoin: string
  /** La commande que l'agent poserait. Lue par un humain, jamais exécutée par le serveur. */
  commandeEnvisagee: string
}

export class OperationInconnueError extends Error {
  constructor(readonly nom: string) {
    super(
      `opération « ${nom} » absente du catalogue · si elle est légitime, elle passe par une proposition hors catalogue et une décision humaine, jamais par une exécution`,
    )
  }
}

/** Horodatage de sauvegarde, en shell : le serveur distant a l'heure, pas nous. */
const HORODATAGE = '$(date +%Y%m%d-%H%M%S)'

/**
 * Rend la commande exacte d'une opération, après validation de ses paramètres.
 *
 * Lève sur une opération inconnue plutôt que de rendre une commande vide : un
 * plan qui contiendrait une opération fantôme doit échouer à la construction,
 * jamais s'exécuter à moitié.
 */
export function rendre(operation: Operation): CommandeRendue {
  const schema = OPERATIONS_SCHEMAS[operation.nom as NomOperation]
  if (!schema) throw new OperationInconnueError(operation.nom)

  switch (operation.nom) {
    case 'lire_fichier': {
      const p = OPERATIONS_SCHEMAS.lire_fichier.parse(operation.params)
      return {
        commande: `cat ${sh(p.chemin)}`,
        sauvegarde: null,
        // Une lecture n'a pas d'inverse parce qu'elle n'a rien changé. Le dire
        // ainsi plutôt que `null` : `null` veut dire « irréversible ».
        inverse: 'sans objet · une lecture ne modifie rien',
        resume: `Lire ${p.chemin}`,
      }
    }

    case 'ecrire_fichier': {
      const p = OPERATIONS_SCHEMAS.ecrire_fichier.parse(operation.params)
      const sauvegarde = `${RACINE_SAUVEGARDES}/$(echo ${sh(p.chemin)} | tr / _)-${HORODATAGE}`
      return {
        // `install -D` crée l'arborescence manquante et pose le mode en une
        // fois. Le contenu passe par un here-document avec un délimiteur cité,
        // donc aucune substitution : ce qui est écrit est ce qui a été montré.
        commande: [
          `mkdir -p ${sh(RACINE_SAUVEGARDES)}`,
          `[ -f ${sh(p.chemin)} ] && cp -p ${sh(p.chemin)} ${sauvegarde}`,
          `cat > ${sh(p.chemin)} <<'SILITHID_EOF'\n${p.contenu}\nSILITHID_EOF`,
          ...(p.mode ? [`chmod ${p.mode} ${sh(p.chemin)}`] : []),
        ].join('\n'),
        sauvegarde,
        inverse: `cp -p ${sauvegarde} ${sh(p.chemin)}`,
        resume: `Écrire ${p.chemin}${p.mode ? ` (mode ${p.mode})` : ''}`,
      }
    }

    case 'installer_paquet': {
      const p = OPERATIONS_SCHEMAS.installer_paquet.parse(operation.params)
      return {
        commande: `DEBIAN_FRONTEND=noninteractive apt-get install -y ${sh(p.paquet)}`,
        sauvegarde: null,
        // Volontairement PAS `apt-get remove` : désinstaller emporterait les
        // dépendances qu'un autre service utilise peut-être déjà. Un inverse
        // qui casse autre chose est pire que pas d'inverse du tout.
        inverse: null,
        resume: `Installer le paquet ${p.paquet}`,
      }
    }

    case 'activer_extension_php': {
      const p = OPERATIONS_SCHEMAS.activer_extension_php.parse(operation.params)
      return {
        commande: `phpenmod ${sh(p.extension)}`,
        sauvegarde: null,
        inverse: `phpdismod ${sh(p.extension)}`,
        resume: `Activer l’extension PHP ${p.extension}`,
      }
    }

    case 'recharger_service': {
      const p = OPERATIONS_SCHEMAS.recharger_service.parse(operation.params)
      return {
        // `reload` et pas `restart` : un rechargement ne coupe pas les
        // connexions en cours. Sur un serveur en service, la différence se
        // mesure en requêtes perdues.
        commande: `systemctl reload ${sh(p.service)}`,
        sauvegarde: null,
        inverse: 'sans objet · un rechargement ne modifie aucun état persistant',
        resume: `Recharger ${p.service}`,
      }
    }

    case 'poser_cron': {
      const p = OPERATIONS_SCHEMAS.poser_cron.parse(operation.params)
      const chemin = `/etc/cron.d/${p.nom}`
      const sauvegarde = `${RACINE_SAUVEGARDES}/cron-${p.nom}-${HORODATAGE}`
      const ligne = `${p.planification} ${p.utilisateur} ${p.commande}`
      return {
        commande: [
          `mkdir -p ${sh(RACINE_SAUVEGARDES)}`,
          `[ -f ${sh(chemin)} ] && cp -p ${sh(chemin)} ${sauvegarde}`,
          `cat > ${sh(chemin)} <<'SILITHID_EOF'\n${ligne}\nSILITHID_EOF`,
          // cron ignore silencieusement un fichier au mauvais mode : sans
          // cette ligne, la tâche ne tournerait jamais et rien ne le dirait.
          `chmod 644 ${sh(chemin)}`,
        ].join('\n'),
        sauvegarde,
        inverse: `rm -f ${sh(chemin)}`,
        resume: `Poser le cron ${p.nom} · ${p.planification}`,
      }
    }
  }
}

/** Vrai si ce nom est dans le catalogue. Utilisé au chargement des recettes (Task 7). */
export function estAuCatalogue(nom: string): nom is NomOperation {
  return Object.hasOwn(OPERATIONS_SCHEMAS, nom)
}

/**
 * Valide une opération sans la rendre. Sert à refuser un plan complet avant
 * d'en exécuter la première ligne — un plan à moitié valide n'existe pas.
 */
export function valider(operation: Operation): { ok: true } | { ok: false; raison: string } {
  if (!estAuCatalogue(operation.nom)) {
    return { ok: false, raison: new OperationInconnueError(operation.nom).message }
  }
  const parsed = OPERATIONS_SCHEMAS[operation.nom].safeParse(operation.params)
  if (!parsed.success) {
    return {
      ok: false,
      raison: `${operation.nom} : ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(' · ')}`,
    }
  }
  return { ok: true }
}

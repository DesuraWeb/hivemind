import { createInterface } from 'node:readline/promises'
import { createUser } from '../auth/users'
import { closeDb, getDb } from './client'

/**
 * Créer le premier compte · `pnpm db:createuser`.
 *
 * ## Le trou que ça bouche
 *
 * Une installation neuve suivant le mode d'emploi arrivait sur un écran de
 * connexion **infranchissable** : `createUser` existait, aucun script ne
 * l'appelait, `db:seed` ne pose que les rôles, et rien dans le README ne
 * mentionnait la création d'un compte. Trouvé à la première vraie mise en
 * service, pas avant · c'est le genre de trou qu'on ne voit pas quand on
 * développe sur une base qu'on a remplie à la main il y a six mois.
 *
 * ## Le mot de passe ne passe jamais par un argument
 *
 * Les arguments d'un processus sont lisibles par n'importe qui via `ps` sur la
 * machine, et ils atterrissent dans l'historique du shell. Il est donc demandé
 * à l'invite, en saisie masquée · ou lu sur l'entrée standard quand elle est
 * redirigée, ce qui rend le script utilisable sans humain sans exposer le
 * secret pour autant.
 *
 * ## Il n'écrase jamais un compte existant
 *
 * `users.login` est unique. Un login déjà pris est refusé AVANT qu'on demande
 * le mot de passe · le taper pour rien est désagréable, et laisser croire
 * qu'on va le changer serait pire. Ce script ne sait pas modifier un compte,
 * et c'est délibéré : un outil qui crée ET écrase réinitialise un accès sur
 * une faute de frappe.
 */

const MIN_MOT_DE_PASSE = 12

/** Ctrl-C et retour arrière, tels que le terminal les envoie en mode brut. */
const CTRL_C = '\u0003'
const RETOUR_ARRIERE = new Set(['\u007f', '\b'])

/** Entrée redirigée : une ligne, telle quelle, sans invite ni écho à couper. */
async function lireLigneRedirigee(): Promise<string> {
  const rl = createInterface({ input: process.stdin })
  for await (const ligne of rl) {
    rl.close()
    return ligne.trim()
  }
  rl.close()
  return ''
}

async function demanderMasque(question: string): Promise<string> {
  process.stdout.write(question)
  const etaitBrut = process.stdin.isRaw ?? false
  // Écho coupé le temps de la frappe : sans ça le mot de passe s'affiche, et
  // surtout il reste dans le scrollback du terminal.
  process.stdin.setRawMode?.(true)

  let saisie = ''
  try {
    for await (const morceau of process.stdin) {
      const texte = String(morceau)
      if (texte === '\r' || texte === '\n') break
      if (texte === CTRL_C) {
        // On rend la main au terminal AVANT de sortir : sinon il reste en mode
        // brut et le shell devient inutilisable.
        process.stdin.setRawMode?.(etaitBrut)
        process.stdout.write('\n')
        process.exit(130)
      }
      if (RETOUR_ARRIERE.has(texte)) {
        saisie = saisie.slice(0, -1)
        continue
      }
      saisie += texte
    }
  } finally {
    process.stdin.setRawMode?.(etaitBrut)
    process.stdout.write('\n')
  }
  return saisie.trim()
}

async function main(): Promise<void> {
  const db = getDb()
  try {
    const interactif = process.stdin.isTTY === true

    let login = (process.argv[2] ?? '').trim()
    if (!login && interactif) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      login = (await rl.question('Login : ')).trim()
      rl.close()
    }
    if (!login) {
      console.error('Login manquant · pnpm db:createuser <login>')
      process.exitCode = 1
      return
    }

    const existant = await db
      .selectFrom('users')
      .select('id')
      .where('login', '=', login)
      .executeTakeFirst()
    if (existant) {
      console.error(
        `Le login « ${login} » existe déjà · ce script crée un compte, il n'en modifie aucun.`,
      )
      process.exitCode = 1
      return
    }

    const motDePasse = interactif
      ? await demanderMasque('Mot de passe : ')
      : await lireLigneRedirigee()

    if (motDePasse.length < MIN_MOT_DE_PASSE) {
      console.error(
        `Mot de passe trop court · ${MIN_MOT_DE_PASSE} caractères minimum. Ce compte ouvre le coffre, les boucles et les serveurs.`,
      )
      process.exitCode = 1
      return
    }

    const user = await createUser(db, login, motDePasse)
    console.log(`Compte « ${user.login} » créé.`)
  } finally {
    await closeDb()
  }
}

await main()

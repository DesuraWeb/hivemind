import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from '../db/types'
import { createInboxItem } from '../inbox/repo'
import { collectStructured } from '../runtime/structured'
import type { RuntimeAdapter } from '../runtime/types'
import { type ResultatApplication, appliquer, raconter } from './apply'
import { apprendreDeLEchec, apprendreDuJuge } from './apprendre'
import { rendre } from './operations'
import type { Operation } from './operations'
import { lireServeur } from './probe'
import type { OpsExecutor, Serveur } from './types'

/**
 * Hébergement vierge : champ libre, puis jugement (Phase 6, Task 4).
 *
 * ## Pourquoi le champ libre est acceptable ici, et seulement ici
 *
 * Sur un serveur mesuré `vierge`, il n'y a rien à casser : pas de site qui
 * réponde, pas de donnée, pas de trafic. Le risque est nul **par
 * construction**, pas par prudence. Demander une validation humaine à chaque
 * étape d'un serveur vide ferait payer à Florian une attention qui ne protège
 * rien — et c'est exactement ce que ce projet existe pour lui rendre.
 *
 * Tout repose donc sur la sonde (`probe.ts`), et c'est pour ça qu'elle traite
 * le moindre doute comme une occupation.
 *
 * ## Le juge constate, le garant décide
 *
 * Même patron que le juge visuel (Phase 4). Après le provisioning, un agent
 * vérifie le résultat contre des critères dérivés de la stack — et il ne rend
 * AUCUNE décision : ni verdict, ni recommandation. Un écart bloquant déclenche
 * une correction, dans la limite d'un nombre d'itérations.
 *
 * ## Le passage à `en_service` est le point de non-retour
 *
 * Dès qu'un provisioning a réussi, le serveur n'est plus vierge et ne le
 * redeviendra jamais — même vidé. Sans ça, il suffirait d'effacer un
 * répertoire pour retrouver le champ libre. Garanti par le trigger de la
 * migration 0011 ; on ne fait que le déclencher.
 */

/**
 * Rapport du juge d'exploitation.
 *
 * Aucun champ de décision, volontairement : pas de `verdict`, pas de
 * `recommandation`, pas d'`action`. Le juge décrit ce qu'il constate sur le
 * serveur ; c'est l'appelant qui en tire une correction ou une fin.
 */
export const rapportProvisionSchema = z.object({
  conformites: z.array(z.string().min(1)),
  ecarts: z.array(
    z.object({
      severite: z.enum(['bloquant', 'majeur', 'mineur']),
      constat: z.string().min(1),
      /** Ce qui a été lu pour l'affirmer. Un écart sans preuve n'est pas un écart. */
      preuve: z.string().min(1),
    }),
  ),
})
export type RapportProvision = z.infer<typeof rapportProvisionSchema>

export const MAX_ITERATIONS_PROVISION = 3

export class ServeurNonViergeError extends Error {
  constructor(serveur: Serveur) {
    super(
      `serveur ${serveur.nom} : provisioning en champ libre refusé, état « ${serveur.etat} ». Le champ libre n'existe que sur un serveur MESURÉ vierge — sur celui-ci, un changement passe par une proposition validée (ops/change-request.ts).`,
    )
  }
}

export interface ProvisionnerDeps {
  db: Kysely<Database>
  executor: OpsExecutor
  adapter: RuntimeAdapter
  serveurId: string
  projectId?: string | null
  /**
   * La stack du projet. Sert uniquement à l'apprentissage : sans elle, ce que
   * ce provisioning découvre n'atteindrait aucune recette et serait perdu.
   */
  stack?: string | null
}

export interface ResultatProvision {
  ok: boolean
  iterations: number
  application: ResultatApplication
  rapport: RapportProvision | null
  /** `true` si le serveur est passé `en_service` — donc si le champ libre est clos. */
  ferme: boolean
  raison: string
}

export interface PlanProvision {
  operations: Operation[]
  /** Ce que le juge doit vérifier. Dérivé de la stack, pas inventé par le juge. */
  criteres: string[]
  /** Prompt système du juge, résolu par l'appelant depuis le rôle `ops`. */
  jugeSystemPrompt: string
  /** Où le juge travaille. Aucun fichier n'y est lu : il interroge le serveur. */
  jugeCwd: string
}

/**
 * Provisionne un serveur vierge, puis fait vérifier.
 *
 * Refuse tout serveur qui n'est pas `vierge` — y compris `inconnu`. Un serveur
 * jamais mesuré n'a droit à aucune autonomie : c'est la même règle que le
 * défaut de la colonne, redite ici parce que l'appelant pourrait avoir lu
 * l'état il y a une heure.
 */
export async function provisionner(
  deps: ProvisionnerDeps,
  plan: PlanProvision,
): Promise<ResultatProvision> {
  const serveur = await lireServeur(deps.db, deps.serveurId)
  if (serveur.etat !== 'vierge') throw new ServeurNonViergeError(serveur)

  let operations = plan.operations
  let application: ResultatApplication = { ok: true, appliquees: [], nonTentees: [] }
  let rapport: RapportProvision | null = null

  for (let iteration = 1; iteration <= MAX_ITERATIONS_PROVISION; iteration++) {
    application = await appliquer({ executor: deps.executor, serveur }, operations)

    if (!application.ok) {
      // Un provisioning interrompu laisse le serveur dans un état intermédiaire.
      // Il reste `vierge` : rien n'a abouti, et le prochain essai doit pouvoir
      // repartir en champ libre plutôt que d'exiger une validation pour rien.
      await alerter(deps, serveur, application, `arrêt sur « ${application.echec?.nom} »`)
      // Source 3 de l'apprentissage : ce qui a cassé. Une opération qui échoue
      // sur une stack échouera encore sur la suivante.
      await apprendreSansFaireEchouer(deps, () =>
        apprendreDeLEchec(
          { db: deps.db, projectId: deps.projectId as string, stack: deps.stack ?? null },
          application,
        ),
      )
      return {
        ok: false,
        iterations: iteration,
        application,
        rapport: null,
        ferme: false,
        raison: `application interrompue · ${application.echec?.erreur ?? 'cause inconnue'}`,
      }
    }

    rapport = await juger(deps, serveur, plan, application)

    // Source 1 de l'apprentissage : ce que le juge a trouvé. Levé quel que
    // soit le verdict — un provisioning qui passe malgré un écart majeur est
    // exactement celui dont le suivant doit se souvenir.
    await apprendreSansFaireEchouer(deps, () =>
      apprendreDuJuge(
        { db: deps.db, projectId: deps.projectId as string, stack: deps.stack ?? null },
        rapport as RapportProvision,
      ),
    )

    const bloquants = rapport.ecarts.filter((e) => e.severite === 'bloquant')

    if (bloquants.length === 0) {
      // Conforme. Le serveur sort du champ libre, définitivement.
      await deps.db
        .updateTable('serveurs')
        .set({ etat: 'en_service', etat_mesure_at: new Date() })
        .where('id', '=', serveur.id)
        .execute()

      return {
        ok: true,
        iterations: iteration,
        application,
        rapport,
        ferme: true,
        raison: `conforme · ${rapport.conformites.length} vérifications passées`,
      }
    }

    if (iteration === MAX_ITERATIONS_PROVISION) break

    // Correction : on rejoue les mêmes opérations. C'est volontairement pauvre
    // — un correctif dérivé automatiquement des écarts serait une opération que
    // personne n'a validée. Le juge dit ce qui ne va pas, un humain arbitre.
    operations = plan.operations
  }

  await alerter(
    deps,
    serveur,
    application,
    `${rapport?.ecarts.filter((e) => e.severite === 'bloquant').length ?? 0} écart(s) bloquant(s) après ${MAX_ITERATIONS_PROVISION} itérations`,
  )

  return {
    ok: false,
    iterations: MAX_ITERATIONS_PROVISION,
    application,
    rapport,
    ferme: false,
    raison: 'écarts bloquants persistants · le serveur reste vierge, il n’est pas en service',
  }
}

/**
 * Le juge lit le serveur et constate. Il n'exécute rien lui-même : ce sont les
 * commandes de VÉRIFICATION, dérivées des opérations appliquées, qui lui sont
 * données déjà exécutées — comme le juge visuel reçoit des captures et non un
 * navigateur.
 */
async function juger(
  deps: ProvisionnerDeps,
  serveur: Serveur,
  plan: PlanProvision,
  application: ResultatApplication,
): Promise<RapportProvision> {
  const session = await deps.adapter.createSession({
    roleKey: 'ops',
    systemPrompt: plan.jugeSystemPrompt,
    cwd: plan.jugeCwd,
    tools: { bash: false, fs: 'none', mcp: [] } as never,
    onEvent: () => {},
  })

  const preambule = [
    `# Vérification du provisioning · serveur ${serveur.nom}`,
    '',
    '## Ce qui a été appliqué',
    ...application.appliquees.map((a) => `- ${a.resume}`),
    '',
    '## Critères à vérifier',
    ...plan.criteres.map((c) => `- ${c}`),
    '',
    '## Ce que tu as réellement sous les yeux',
    "La sortie de chaque commande appliquée, ci-dessous. Tu ne disposes d'aucun outil : " +
      "ce qui n'est pas là n'a pas été observé, et un critère que tu ne peux pas vérifier " +
      'est un écart `majeur` dont la preuve est « non vérifiable avec ce que j’ai ».',
    '',
    ...application.appliquees.map(
      (a) => `### ${a.resume}\n\`\`\`\n${a.sortie || '(aucune sortie)'}\n\`\`\``,
    ),
    '',
    'Tu constates, tu ne décides pas. Aucune recommandation, aucun correctif : ' +
      'des conformités et des écarts, chacun avec sa preuve.',
  ].join('\n')

  return collectStructured(deps.adapter, session, preambule, rapportProvisionSchema, {
    toolName: 'submit_rapport_provision',
    toolDescription:
      'Rend le constat de vérification du provisioning : ce qui est conforme, et les écarts avec leur preuve.',
  })
}

/**
 * L'apprentissage ne doit jamais faire échouer un provisioning.
 *
 * Même arbitrage que les propositions de savoir dans `verdict.ts` : une
 * trouvaille est strictement additive. La laisser tomber le provisioning
 * ferait rejouer des opérations DÉJÀ APPLIQUÉES sur un serveur — et rejouer
 * une suite à moitié appliquée est exactement ce que toute cette phase refuse.
 *
 * Sans `projectId`, il n'y a pas de projet donc pas de stack donc pas de
 * recette à enrichir : on n'apprend rien plutôt que de ranger le savoir
 * quelque part au hasard.
 */
async function apprendreSansFaireEchouer(
  deps: ProvisionnerDeps,
  action: () => Promise<number>,
): Promise<void> {
  if (!deps.projectId || !deps.stack) return
  try {
    await action()
  } catch {
    // Silencieux ici, contrairement à `verdict.ts` qui trace dans le bus : un
    // provisioning n'a pas forcément de run, donc pas de timeline où écrire.
  }
}

async function alerter(
  deps: ProvisionnerDeps,
  serveur: Serveur,
  application: ResultatApplication,
  cause: string,
): Promise<void> {
  await createInboxItem(deps.db, {
    type: 'alert',
    projectId: deps.projectId ?? null,
    fromRole: 'ops',
    title: `Provisioning échoué · ${serveur.nom}`,
    payload: {
      cause,
      ctx: raconter(application, serveur),
      serveur: { id: serveur.id, nom: serveur.nom },
      appliquees: application.appliquees.map((a) => a.resume),
      nonTentees: application.nonTentees,
      retourArriere: application.echec?.retourArriere ?? [],
      irreversibles: application.echec?.irreversibles ?? [],
    },
  })
}

/**
 * Critères de vérification dérivés des opérations du plan.
 *
 * Dérivés, pas demandés au juge : un juge qui écrirait lui-même ses critères
 * se noterait lui-même. C'est le même arbitrage que le juge visuel, dont les
 * critères viennent du cadrage du garant et jamais de lui.
 */
export function criteresDepuisOperations(operations: Operation[]): string[] {
  return operations.map((op) => {
    const r = rendre(op)
    switch (op.nom) {
      case 'installer_paquet':
        return `${r.resume} · le paquet doit être présent et sa version affichée`
      case 'ecrire_fichier':
        return `${r.resume} · le fichier doit exister et contenir ce qui a été écrit`
      case 'activer_extension_php':
        return `${r.resume} · l’extension doit apparaître dans les modules chargés`
      case 'recharger_service':
        return `${r.resume} · le service doit être actif après rechargement`
      case 'poser_cron':
        return `${r.resume} · le fichier de cron doit exister en mode 644`
      default:
        return r.resume
    }
  })
}

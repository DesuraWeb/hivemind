import { tmpdir } from 'node:os'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { createClientKbSurface, readPolicyMcp } from '../knowledge/client-kb'
import { resolveProjectRole } from '../loop/roles'
import { collectStructured } from '../runtime/structured'
import type { RuntimeAdapter, SendOptions } from '../runtime/types'
import { createOpsReadSurface } from './mcp'
import { type OpsPlan, opsPlanSchemaPour } from './plan'
import { lireServeur } from './probe'
import { recetteComplete } from './recipes'
import { type OpsExecutor, type Serveur, contexteDuServeur } from './types'

/**
 * Faire travailler l'agent d'exploitation.
 *
 * Il rend un PLAN, jamais un effet. Ce que l'appelant en fait dépend de l'état
 * du serveur — champ libre (`provision.ts`) ou proposition validée
 * (`change-request.ts`) — et cette décision ne lui appartient pas : elle est
 * prise ici, à partir d'une mesure, pas d'une déclaration.
 *
 * ## Ce qu'il reçoit, et pourquoi chaque morceau
 *
 * - **L'état du serveur, mesuré**, avec ses preuves. Pour qu'il sache dans
 *   quel régime il travaille sans avoir à le deviner — et surtout pour qu'il
 *   ne l'affirme jamais lui-même.
 * - **La recette de la stack**, s'il en existe une. C'est le « le 15ᵉ
 *   déploiement n'est pas le premier » de Florian : ce qu'on a appris à faire
 *   pour cette stack arrive dans le prompt sans qu'il ait à le redécouvrir.
 * - **La fiche client** (`client_kb`), pour les contraintes que le client a
 *   déjà posées et qu'on ne veut pas lui redemander.
 * - **La lecture de configuration** (`ops_read`), pour constater au lieu de
 *   supposer.
 *
 * Rien d'autre. Aucun outil d'écriture, sur aucune des deux machines.
 */

export interface DemanderPlanDeps {
  db: Kysely<Database>
  adapter: RuntimeAdapter
  executor: OpsExecutor
  serveurId: string
  /** Le projet pour lequel on intervient. Porte la stack, donc la recette. */
  projectId: string
  /** Ce qu'on demande, en une phrase. Dicté par Florian ou par un step. */
  besoin: string
}

export interface PlanDemande {
  serveur: Serveur
  plan: OpsPlan
  /** La recette appliquée, si une stack correspondait. `null` se dit, il ne s'invente pas. */
  recette: string | null
}

export async function demanderPlan(deps: DemanderPlanDeps): Promise<PlanDemande> {
  const serveur = await lireServeur(deps.db, deps.serveurId)

  const projet = await deps.db
    .selectFrom('projects')
    .select(['id', 'name', 'stack'])
    .where('id', '=', deps.projectId)
    .executeTakeFirstOrThrow()

  const role = await resolveProjectRole(deps.db, projet.id, 'ops')
  // La recette COMPLÈTE : le socle écrit à la main, plus ce que les
  // déploiements précédents ont appris. C'est ici que « le 15ᵉ déploiement
  // n'est pas le premier » devient vrai.
  //
  // Le contexte d'hébergement branche la cascade de mémoire (migration 0016) :
  // sans lui, seuls les savoirs universels remontent, et « monter PHP chez
  // PlanetHoster » resterait invisible sur le serveur qui en a précisément
  // besoin.
  const recette = await recetteComplete(deps.db, projet.stack, contexteDuServeur(serveur))

  const kb = createClientKbSurface({ db: deps.db, tools: role.tools, projetId: projet.id })
  const lecture = createOpsReadSurface({ executor: deps.executor, serveur, tools: role.tools })

  const extra: SendOptions = {
    extraMcpServers: {
      ...kb.sendOptions.extraMcpServers,
      ...lecture.sendOptions.extraMcpServers,
    },
    extraAllowedTools: [
      ...(kb.sendOptions.extraAllowedTools ?? []),
      ...(lecture.sendOptions.extraAllowedTools ?? []),
    ],
  }

  const session = await deps.adapter.createSession({
    roleKey: 'ops',
    systemPrompt: role.systemPrompt,
    // `fs: 'none'` (db/seed.ts) : ce cwd n'est jamais consulté.
    cwd: tmpdir(),
    tools: role.tools as never,
    onEvent: () => {},
  })

  const plan = await collectStructured(
    deps.adapter,
    session,
    construirePreambule({ serveur, projet, besoin: deps.besoin, recette }),
    // Le schéma est restreint à ce que CE type d'hébergement permet : sur un
    // mutualisé, le modèle ne voit même pas `installer_paquet`. Le filtrer
    // par consigne de prompt marcherait presque toujours, et « presque »
    // signifie un plan irréalisable et un aller-retour de validation pour
    // rien.
    opsPlanSchemaPour(serveur.typeHebergement),
    {
      toolName: 'submit_plan_ops',
      toolDescription:
        'Rend le plan d’exploitation : ce que tu as constaté, ce que tu supposes, les opérations ' +
        'dans l’ordre avec leur raison, et ce que le catalogue ne couvre pas.',
      extra,
    },
  )

  return { serveur, plan, recette }
}

function construirePreambule(opts: {
  serveur: Serveur
  projet: { name: string; stack: string | null }
  besoin: string
  recette: string | null
}): string {
  const { serveur, projet, besoin, recette } = opts

  const regime =
    serveur.etat === 'vierge'
      ? 'Ce serveur est VIERGE (mesuré) : ton plan s’exécutera d’un bloc, puis un juge vérifiera. ' +
        'Il n’y a rien à casser — ce n’est pas une invitation à en faire plus que demandé.'
      : 'Ce serveur est EN SERVICE (mesuré) : ton plan partira en validation humaine avec ses ' +
        'commandes exactes et ses retours arrière. Chaque opération doit pouvoir se défendre ' +
        'devant quelqu’un qui n’ouvrira pas de terminal.'

  return [
    `# Intervention · serveur ${serveur.nom} (${serveur.hote})`,
    `Projet « ${projet.name} »${projet.stack ? ` · stack ${projet.stack}` : ''}`,
    '',
    '## Régime',
    regime,
    '',
    '## Ce que la sonde a constaté',
    ...serveur.preuves.map((p) => `- ${p.nom} · ${p.verdict} · ${p.detail}`),
    '',
    '## Le besoin',
    besoin,
    '',
    ...(recette
      ? [recette, '']
      : [
          '# Recette de stack',
          projet.stack
            ? `RECETTE MANQUANTE pour « ${projet.stack} ». Personne n’a encore écrit ce qu’on a appris pour cette stack : dis-le dans ton plan plutôt que d’inventer une marche à suivre.`
            : 'Le projet ne déclare aucune stack. Ne suppose pas laquelle.',
          '',
        ]),
    '## Avant de proposer',
    'Lis ce que tu peux lire (`lire_config`) plutôt que de le supposer. Ce que tu n’as pas lu ' +
      'va dans `suppose`, jamais dans `constate`.',
    '',
    'Si une opération dont tu as besoin n’est pas au catalogue, remplis `hors_catalogue` : ' +
      'c’est une réponse attendue, pas un échec. Personne ne l’exécutera, et si elle est ' +
      'légitime elle rejoindra le catalogue après une décision humaine.',
  ].join('\n')
}

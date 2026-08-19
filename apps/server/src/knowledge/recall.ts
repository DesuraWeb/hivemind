import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/types'
import { type Savoir, actifsDuCercle } from './store'

/**
 * Le rappel en cascade : projet → client → globe → hive.
 *
 * « Le plus spécifique gagne » (spec §01). Concrètement : deux savoirs de même
 * SUJET dans des cercles différents ne s'additionnent pas — celui du cercle le
 * plus proche du projet écrase l'autre. Une convention d'agence peut donc être
 * contredite par une contrainte propre à un client, et une contrainte client
 * par une décision propre à un projet, sans que personne n'ait à supprimer
 * quoi que ce soit.
 *
 * Sans cette règle, un agent recevrait « PHP 8.1 max » (globe) ET « PHP 8.3 »
 * (ce client-là) et devrait trancher seul. C'est précisément ce qu'on ne veut
 * pas lui demander.
 *
 * ## Le compteur d'utilité
 *
 * Chaque savoir réellement rendu voit son compteur incrémenté. L'écriture est
 * faite en UNE requête pour tout le lot, après la lecture, et son échec ne
 * fait pas échouer le rappel : perdre un point de compteur est sans
 * conséquence, ne pas rendre la mémoire à l'agent en a une.
 */

export interface ContexteRappel {
  projetId?: string | null
  clientId?: string | null
  globeId?: string | null
}

export interface SavoirRappele extends Savoir {
  /** D'où il vient, pour que l'agent sache à quel point il est spécifique. */
  provenance: 'projet' | 'client' | 'globe' | 'hive'
}

/**
 * Ordre de la cascade. Le premier cercle qui porte un sujet l'emporte pour ce
 * sujet ; les cercles suivants n'apportent que les sujets non encore couverts.
 */
const ORDRE = ['projet', 'client', 'globe', 'hive'] as const

export async function rappeler(
  db: Kysely<Database>,
  ctx: ContexteRappel,
): Promise<SavoirRappele[]> {
  const instances: Record<(typeof ORDRE)[number], string | null | undefined> = {
    projet: ctx.projetId,
    client: ctx.clientId,
    globe: ctx.globeId,
    hive: null,
  }

  const retenus: SavoirRappele[] = []
  const sujetsCouverts = new Set<string>()

  for (const cercle of ORDRE) {
    // Un cercle dont on ne connaît pas l'instance est sauté : mieux vaut une
    // cascade incomplète qu'un rappel qui pioche dans le globe d'un autre.
    if (cercle !== 'hive' && !instances[cercle]) continue

    const savoirs = await actifsDuCercle(db, {
      cercle,
      cercleId: cercle === 'hive' ? null : (instances[cercle] ?? null),
    })

    for (const s of savoirs) {
      const cle = s.sujet.toLowerCase()
      if (sujetsCouverts.has(cle)) continue
      sujetsCouverts.add(cle)
      retenus.push({ ...s, provenance: cercle })
    }
  }

  if (retenus.length > 0) {
    try {
      // Une seule requête pour tout le lot : un agent qui consulte dix fois
      // dans un run ne doit pas produire dix écritures bloquantes.
      await sql`
        update savoirs set rappels = rappels + 1
        where id = any(${sql.val(retenus.map((s) => s.id))}::uuid[])
      `.execute(db)
    } catch {
      // Perdre un point de compteur est sans conséquence ; ne pas rendre la
      // mémoire à l'agent en a une. On rend quand même.
    }
  }

  return retenus
}

/** Rend la cascade en texte, pour l'injection dans un prompt. */
export function formaterRappel(savoirs: SavoirRappele[]): string {
  if (savoirs.length === 0) return ''
  const lignes = savoirs.map((s) => `- [${s.provenance}] ${s.sujet} · ${s.contenu}`)
  return [
    '## Ce qui est déjà su',
    'Vérifié et validé par un humain. Le plus spécifique a déjà gagné : ne recoupe pas, applique.',
    ...lignes,
  ].join('\n')
}

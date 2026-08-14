import type { RunDetailView } from '../../lib/api'
import { isHumanInstruction, roleColor, roleLabel } from './state'

export interface FeedEntry {
  key: string
  at: string
  /** Auteur affiché : un rôle, « boucle » pour une transition, « vous » pour une consigne. */
  who: string
  color: string
  /**
   * Ligne mono à droite du nom. Le pack met le coût en tokens de l'événement à
   * cet endroit ; aucun message du bus ne porte de coût (`messages.meta` n'a
   * pas de champ de tokens, seul `runs.cost_tokens` agrège), donc on y met ce
   * qu'on sait vraiment : la nature du message et son destinataire.
   */
  note: string
  body: string
}

/** « 14:07 » — l'heure seule, comme la colonne de gauche du pack. */
export function feedTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

/**
 * Le flux d'événements de l'écran.
 *
 * Deux sources réelles, fusionnées dans l'ordre chronologique : les passations
 * du bus (`timeline`) et les artefacts produits (`artifacts`). Le pack en
 * invente une troisième (« mémoire · rappel gratuit ») ; rien côté serveur
 * n'émet ce genre d'événement aujourd'hui — la cascade mémoire n'est pas
 * branchée — donc il n'y a rien à afficher plutôt qu'un rappel fabriqué.
 */
export function buildFeed(run: Pick<RunDetailView, 'timeline' | 'artifacts'>): FeedEntry[] {
  const messages = run.timeline.map((m): FeedEntry => {
    if (isHumanInstruction(m)) {
      return {
        key: `m-${m.id}`,
        at: m.at,
        who: 'vous',
        color: roleColor('human'),
        note: `consigne → ${roleLabel(m.toRole)} · lue au prochain tour`,
        body: m.body,
      }
    }
    // `system → system` : les transitions d'état tracées par l'orchestrateur
    // (« coding → awaiting_human (question) »). Le pack les appelle « boucle ».
    const isTransition = m.fromRole === 'system' && m.toRole === 'system'
    return {
      key: `m-${m.id}`,
      at: m.at,
      who: roleLabel(m.fromRole),
      color: roleColor(m.fromRole),
      note: isTransition ? 'transition' : `${m.kind} → ${roleLabel(m.toRole)}`,
      body: m.body,
    }
  })

  const artifacts = run.artifacts.map(
    (a): FeedEntry => ({
      key: `a-${a.id}`,
      at: a.at,
      who: 'artefact',
      // Le gris clair que le pack réserve à ses événements sans agent.
      color: '#C9D8EE',
      note: a.kind,
      body: a.path,
    }),
  )

  // `sort` est stable : à horodatage égal, l'ordre du serveur (created_at puis
  // id pour les messages) est conservé.
  return [...messages, ...artifacts].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  )
}

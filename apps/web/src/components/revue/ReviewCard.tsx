import type { RefObject } from 'react'
import { formatAge } from '../../lib/age'
import type { InboxItemView, InboxResponsePayload } from '../../lib/inbox-types'
import { pickPanel } from '../inbox/DetailPanel'
import { SEM, shortId, tagLabel } from '../inbox/constants'

/**
 * La carte plein écran de la Revue (`Revue du matin.dc.html`).
 *
 * ## Pourquoi le corps est un panneau d'Inbox, tel quel
 *
 * La Revue est un **mode de présentation** de l'inbox, pas une seconde source
 * de données ni un second jeu de gestes : même `GET /api/inbox`, même
 * `POST /api/inbox/:id/resolve`. Réécrire ici les cinq corps typés
 * (question, email, prod, verdict, alerte) créerait deux rendus du même item
 * qui divergeraient au premier ajout de champ. `pickPanel` est donc appelé
 * exactement comme dans `DetailPanel`, et le panneau garde ses actions et son
 * état local (réponse tapée, corps d'email édité, motif de refus).
 *
 * Conséquence assumée : le prototype loge le raccourci dans le bouton
 * (« Traiter · entrée »), et ce bouton appartient maintenant au panneau. La
 * légende du bas porte les raccourcis à sa place. `entrée` presse l'action
 * principale du panneau (repérée par `data-panel-primary`) — ce que ferait la
 * souris, avec l'état que le panneau a en main.
 *
 * `key={item.id}` est posé par l'appelant, comme dans `DetailPanel` : changer
 * d'item démonte le panneau, une réponse tapée pour la question précédente ne
 * doit jamais survivre au changement de carte.
 */

export interface ReviewCardProps {
  item: InboxItemView
  projectName: string
  resolving: boolean
  onResolve: (response: InboxResponsePayload) => void
  /** « Reporter » : renvoie l'item en fin de file (la touche `r` fait la même chose). */
  onDefer: () => void
  /** Sert à retrouver l'action principale du panneau au clavier. */
  cardRef: RefObject<HTMLDivElement | null>
  /** Animation de bascule entre deux cartes (fondu + léger glissement). */
  visible: boolean
}

export function ReviewCard({
  item,
  projectName,
  resolving,
  onResolve,
  onDefer,
  cardRef,
  visible,
}: ReviewCardProps) {
  const Panel = pickPanel(item)
  const color = SEM[item.type]

  return (
    <div
      ref={cardRef}
      style={{
        width: 'min(720px, 100%)',
        maxHeight: '100%',
        overflowY: 'auto',
        opacity: visible ? 1 : 0,
        transform: `translateY(${visible ? '0px' : '14px'})`,
        transition: 'opacity var(--dur-3) var(--ease), transform var(--dur-3) var(--ease-out)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ font: '600 10.5px var(--font-mono)', letterSpacing: '0.14em', color }}>
            {tagLabel(item.type, item.sub)}
          </span>
          <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
            {projectName} · {item.agent ?? '·'} · {shortId(item.id)}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              font: '11px var(--font-mono)',
              color: 'var(--text-low)',
              whiteSpace: 'nowrap',
            }}
          >
            {formatAge(item.blockedSince)}
          </span>
        </div>

        <div
          style={{
            fontSize: 21,
            fontWeight: 600,
            lineHeight: 1.35,
            textWrap: 'pretty',
            borderLeft: `3px solid ${color}`,
            paddingLeft: 16,
          }}
        >
          {item.title}
        </div>

        <Panel
          key={item.id}
          item={item}
          projectName={projectName}
          resolving={resolving}
          onResolve={onResolve}
          // « Reporter » du prototype : les panneaux qui offrent de refermer
          // sans résoudre (Question, Verdict) tombent naturellement dessus.
          onClose={onDefer}
        />
      </div>
    </div>
  )
}

import type { ReactElement } from 'react'
import { formatAge } from '../../lib/age'
import type { InboxItemView, InboxResponsePayload } from '../../lib/inbox-types'
import { SEM, shortId, tagLabel } from './constants'
import { AlertPanel } from './panels/AlertPanel'
import { EmailApprovalPanel } from './panels/EmailApprovalPanel'
import { GenericApprovalPanel } from './panels/GenericApprovalPanel'
import { OpsApprovalPanel } from './panels/OpsApprovalPanel'
import { ProdApprovalPanel } from './panels/ProdApprovalPanel'
import { QuestionPanel } from './panels/QuestionPanel'
import { RevuePanel } from './panels/RevuePanel'
import { SavoirPanel } from './panels/SavoirPanel'
import { VerdictPanel } from './panels/VerdictPanel'
import type { PanelProps } from './panels/types'

/**
 * Panneau de traitement : transparent, un seul filet vertical (`borderLeft:
 * 1px solid var(--line)`) le sépare de la liste — jamais de panneau de verre
 * (CLAUDE.md : « panneau de traitement transparent »). Dispatche vers l'un
 * des 5 panneaux typés (question, approval·email, approval·prod, verdict,
 * alert) + le rappel de revue (info·revue) + l'affordance approval·savoir (jamais alimentée) + un repli
 * générique pour les autres sous-types d'approbation.
 */
export function pickPanel(item: InboxItemView): (props: PanelProps) => ReactElement {
  if (item.type === 'question') return QuestionPanel
  if (item.type === 'verdict') return VerdictPanel
  if (item.type === 'alert') return AlertPanel
  // Le rappel de revue des savoirs : un `info`, pas une décision. Sans cette
  // ligne il tomberait dans le repli générique, qui propose approuver/refuser
  // sur un item qui ne demande ni l'un ni l'autre.
  if (item.type === 'info' && item.sub === 'revue') return RevuePanel
  if (item.type === 'approval') {
    if (item.sub === 'email') return EmailApprovalPanel
    if (item.sub === 'prod') return ProdApprovalPanel
    if (item.sub === 'savoir') return SavoirPanel
    // Un changement serveur : la commande exacte, sa sauvegarde, son retour
    // arrière. Sans ce panneau il tomberait dans le repli générique, qui
    // demanderait d'approuver un titre — sur une machine de production.
    if (item.sub === 'ops') return OpsApprovalPanel
    return GenericApprovalPanel
  }
  return GenericApprovalPanel
}

export interface DetailPanelProps {
  item: InboxItemView | null
  projectName: string
  resolving: boolean
  onResolve: (id: string, response: InboxResponsePayload) => void
  onClose: () => void
  /**
   * `colonne` (défaut) : le panneau tient la moitié droite de l'écran, séparé
   * de la liste par un filet vertical. `feuille` : il est le contenu d'un
   * bottom-sheet — plus de filet (il n'y a plus rien à sa gauche), plus de
   * croix (le voile et la poignée ferment), et des marges de pouce.
   */
  variant?: 'colonne' | 'feuille'
}

export function DetailPanel({
  item,
  projectName,
  resolving,
  onResolve,
  onClose,
  variant = 'colonne',
}: DetailPanelProps) {
  const sheet = variant === 'feuille'

  if (!item) {
    // En feuille, l'absence de sélection n'a rien à afficher : la feuille est
    // hors écran. Un « sélectionnez un item » y serait un message adressé à
    // personne.
    if (sheet) return null
    return (
      <section
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderLeft: '1px solid var(--line)',
        }}
      >
        <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
          sélectionnez un item à traiter
        </span>
      </section>
    )
  }

  const Panel = pickPanel(item)
  const semColor = SEM[item.type]

  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: sheet ? 'none' : '1px solid var(--line)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          padding: sheet ? '0 18px 12px' : '6px 18px 16px 26px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                font: '600 10px var(--font-mono)',
                letterSpacing: '0.12em',
                color: semColor,
              }}
            >
              {tagLabel(item.type, item.sub)}
            </span>
            <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
              {shortId(item.id)}
            </span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.3, letterSpacing: '-0.01em' }}>
            {item.title}
          </div>
          <div style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
            {projectName} · {item.agent ?? '·'} · {formatAge(item.blockedSince)}
          </div>
        </div>
        {/* En feuille, la croix disparaît : le voile et la poignée ferment, et
            une cible de 26px n'a rien à faire sur un écran tactile. */}
        {!sheet && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer le panneau"
            style={{
              marginLeft: 'auto',
              width: 26,
              height: 26,
              flexShrink: 0,
              borderRadius: 'var(--r-sm)',
              border: '1px solid transparent',
              background: 'transparent',
              color: 'var(--text-mid)',
              cursor: 'pointer',
              fontSize: 15,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        )}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: sheet ? '16px 18px 4px' : '18px 18px 18px 26px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <Panel
          // Force un remontage complet à chaque changement d'item sélectionné :
          // sans ça, l'état local d'un panneau (réponse tapée, proposition Hive
          // en cours…) survivrait au changement de question, invisible mais faux.
          key={item.id}
          item={item}
          projectName={projectName}
          resolving={resolving}
          onResolve={(response) => onResolve(item.id, response)}
          onClose={onClose}
        />
      </div>
    </section>
  )
}

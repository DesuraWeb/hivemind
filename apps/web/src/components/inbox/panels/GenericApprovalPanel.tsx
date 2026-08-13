import { PanelActions, PanelButton } from '../PanelKit'
import type { PanelProps } from './types'

/**
 * Repli pour les sous-types d'approbation hors des deux couverts par le
 * prototype (email, prod) — notamment `step_end` (verdict conforme en mode
 * gated, run-state.ts). Pas dans le pack DA : aucune maquette à suivre au
 * pixel, donc une approbation minimale plutôt qu'une invention de mise en
 * page.
 */
export function GenericApprovalPanel({ item, resolving, onResolve }: PanelProps) {
  const reason = typeof item.payload.reason === 'string' ? item.payload.reason : item.title

  return (
    <>
      <div style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6 }}>{reason}</div>
      <PanelActions>
        <PanelButton
          variant="primary"
          disabled={resolving}
          onClick={() => onResolve({ approved: true })}
        >
          Valider
        </PanelButton>
        <PanelButton
          variant="danger"
          disabled={resolving}
          onClick={() => onResolve({ approved: false })}
        >
          Refuser
        </PanelButton>
      </PanelActions>
    </>
  )
}

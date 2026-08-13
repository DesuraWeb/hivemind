import { PanelActions, PanelButton, SectionLabel } from '../PanelKit'
import type { PanelProps } from './types'

/**
 * Affordance `approval · savoir` — rendue, jamais alimentée dans cette phase
 * (plan Phase 3, Task 7 : « la conscience collective entre dans le produit »
 * mais pas cette phase-ci ; l'inbox accepte déjà le sous-type, personne ne le
 * produit). Aucun item de ce sous-type n'existe en base à ce stade : ce
 * composant n'est donc jamais monté en usage réel — il documente
 * l'emplacement où la Task « conscience collective » viendra brancher
 * Archiver/Refuser/fusion, sans en construire la logique.
 */
export function SavoirPanel({ item, projectName }: PanelProps) {
  const text = typeof item.payload.text === 'string' ? item.payload.text : item.title

  return (
    <>
      <div style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
        proposé par {projectName} · {item.agent ?? '·'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SectionLabel>Formulation</SectionLabel>
        <span style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6 }}>{text}</span>
      </div>
      <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
        conscience collective · phase dédiée, pas encore branchée
      </span>
      <PanelActions>
        <PanelButton variant="primary" disabled title="arrive avec la conscience collective">
          Archiver
        </PanelButton>
        <PanelButton variant="danger" disabled title="arrive avec la conscience collective">
          Refuser
        </PanelButton>
      </PanelActions>
    </>
  )
}

import { PanelActions, PanelButton, SectionLabel } from '../PanelKit'
import type { PanelProps } from './types'

export function AlertPanel({ item, resolving, onResolve }: PanelProps) {
  const cause = typeof item.payload.cause === 'string' ? item.payload.cause : item.title
  const ctx = typeof item.payload.ctx === 'string' ? item.payload.ctx : null

  /**
   * Les trois actions agissent sur un RUN · relancer la boucle, relever la
   * borne d'itérations, stopper le step. Sur une alerte système — jauge de
   * budget muette, authentification indisponible — il n'y a pas de run, et
   * elles proposaient d'agir sur quelque chose qui n'est pas en cause.
   *
   * Un bouton sans destinataire est absent, pas grisé : c'est la règle du
   * dépôt, appliquée ici où elle ne l'était pas.
   */
  const surUnRun = Boolean(item.runId)

  return (
    <>
      <div
        style={{
          border: '1px solid color-mix(in oklab, var(--sem-alert) 30%, transparent)',
          borderLeft: '3px solid var(--sem-alert)',
          borderRadius: 'var(--r-md)',
          background: 'color-mix(in oklab, var(--sem-alert) 6%, transparent)',
          padding: '13px 15px',
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
        }}
      >
        <span
          style={{
            font: '600 10px var(--font-sans)',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--sem-alert)',
          }}
        >
          Cause
        </span>
        <span style={{ fontSize: 13, color: 'var(--text-hi)', fontWeight: 500, lineHeight: 1.55 }}>
          {cause}
        </span>
        {ctx && (
          <span
            style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)', lineHeight: 1.6 }}
          >
            {ctx}
          </span>
        )}
      </div>

      {surUnRun && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>Actions contextuelles</SectionLabel>
          <PanelActions>
            <PanelButton
              variant="primary"
              disabled={resolving}
              onClick={() => onResolve({ action: 'relaunch' })}
            >
              Relancer la boucle
            </PanelButton>
            <PanelButton
              variant="secondary"
              disabled={resolving}
              onClick={() => onResolve({ action: 'raise_max_iterations', maxIterations: 6 })}
            >
              max_iterations → 6
            </PanelButton>
            <PanelButton
              variant="danger"
              disabled={resolving}
              onClick={() => onResolve({ action: 'stop' })}
            >
              Stopper le step
            </PanelButton>
          </PanelActions>
        </div>
      )}
    </>
  )
}

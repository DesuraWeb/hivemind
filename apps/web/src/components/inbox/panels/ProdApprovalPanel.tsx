import { CtxLine, PanelButton } from '../PanelKit'
import type { PanelProps } from './types'

interface ProdPayload {
  step: string | undefined
  iters: string | undefined
  verdict: string | undefined
  pr: string | undefined
}

function readProd(payload: Record<string, unknown>): ProdPayload {
  const prod = payload.prod
  if (typeof prod !== 'object' || prod === null) {
    return { step: undefined, iters: undefined, verdict: undefined, pr: undefined }
  }
  const p = prod as Record<string, unknown>
  return {
    step: typeof p.step === 'string' ? p.step : undefined,
    iters: typeof p.iters === 'string' ? p.iters : undefined,
    verdict: typeof p.verdict === 'string' ? p.verdict : undefined,
    pr: typeof p.pr === 'string' ? p.pr : undefined,
  }
}

// Panneau « approval · prod » (Inbox.dc.html, sc-if selP) : une seule action,
// irréversible — pas de refus ici, le déploiement en prod n'a pas d'ambiguïté
// à trancher comme un brouillon d'email.
export function ProdApprovalPanel({ item, resolving, onResolve }: PanelProps) {
  const prod = readProd(item.payload)
  const ctx = typeof item.payload.ctx === 'string' ? item.payload.ctx : null

  return (
    <>
      {ctx && <CtxLine>{ctx}</CtxLine>}
      <div
        style={{
          borderLeft: '2px solid color-mix(in oklab, var(--sem-approval) 45%, transparent)',
          padding: '2px 0 2px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>{prod.step ?? item.title}</span>
          {prod.iters && (
            <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
              {prod.iters}
            </span>
          )}
        </div>
        {prod.verdict && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--ok)' }}
              aria-hidden="true"
            />
            <span style={{ fontSize: 13, color: 'var(--text-mid)' }}>
              Verdict du juge : {prod.verdict}
            </span>
          </div>
        )}
        {prod.pr && (
          <div
            style={{
              font: '11.5px var(--font-mono)',
              color: 'var(--text-mid)',
              borderTop: '1px solid var(--line)',
              paddingTop: 10,
            }}
          >
            {prod.pr}
          </div>
        )}
      </div>

      <PanelButton
        variant="primary"
        disabled={resolving}
        onClick={() => onResolve({ approved: true, action: 'deploy' })}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '14px 16px',
          border: '1px solid color-mix(in oklab, var(--accent) 45%, transparent)',
          background: 'color-mix(in oklab, var(--accent) 9%, var(--bg-2))',
          textAlign: 'left',
          boxSizing: 'border-box',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <path
            d="M9 15V4M9 4L4.5 8.5M9 4l4.5 4.5"
            stroke="var(--accent)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M3.5 15h11"
            stroke="var(--accent)"
            strokeWidth="1.6"
            strokeLinecap="round"
            opacity="0.45"
          />
        </svg>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ font: '600 14px var(--font-sans)', color: 'var(--text-hi)' }}>
            Déclencher la mise en prod
          </span>
          <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
            action irréversible · déploiement staging → production
          </span>
        </span>
      </PanelButton>
    </>
  )
}

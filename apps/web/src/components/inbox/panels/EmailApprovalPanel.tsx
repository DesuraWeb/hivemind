import type { CSSProperties } from 'react'
import { useState } from 'react'
import { CtxLine, PanelActions, PanelButton, textareaStyle } from '../PanelKit'
import type { PanelProps } from './types'

interface EmailPayload {
  from: string | undefined
  to: string | undefined
  subject: string | undefined
  body: string | undefined
}

function readEmail(payload: Record<string, unknown>): EmailPayload {
  const email = payload.email
  if (typeof email !== 'object' || email === null) {
    return { from: undefined, to: undefined, subject: undefined, body: undefined }
  }
  const e = email as Record<string, unknown>
  return {
    from: typeof e.from === 'string' ? e.from : undefined,
    to: typeof e.to === 'string' ? e.to : undefined,
    subject: typeof e.subject === 'string' ? e.subject : undefined,
    body: typeof e.body === 'string' ? e.body : undefined,
  }
}

const fieldRow: CSSProperties = { display: 'flex', gap: 10 }
const fieldLabel: CSSProperties = { color: 'var(--text-low)', width: 44 }

// Panneau « approval · email » (Inbox.dc.html, sc-if selE). Le communicant
// (Task 10) n'existe pas encore dans cette phase — le brouillon vient donc
// intégralement du `payload` de l'item, quelle que soit sa source (démo ou
// futur communicant réel), jamais recalculé côté front.
export function EmailApprovalPanel({ item, resolving, onResolve }: PanelProps) {
  const email = readEmail(item.payload)
  const ctx = typeof item.payload.ctx === 'string' ? item.payload.ctx : null
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(email.body ?? '')
  const [refuseOpen, setRefuseOpen] = useState(false)
  const [refuseReason, setRefuseReason] = useState('')

  return (
    <>
      {ctx && <CtxLine>{ctx}</CtxLine>}
      <div
        style={{
          border: '1px solid var(--line-strong)',
          borderRadius: 'var(--r-md)',
          background: 'rgba(9, 14, 22, 0.55)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            font: '11.5px var(--font-mono)',
            background: 'rgba(9, 14, 22, 0.35)',
          }}
        >
          <div style={fieldRow}>
            <span style={fieldLabel}>De</span>
            <span style={{ color: 'var(--text-mid)' }}>{email.from ?? '·'}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>À</span>
            <span style={{ color: 'var(--text-mid)' }}>{email.to ?? '·'}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Objet</span>
            <span style={{ color: 'var(--text-hi)', fontWeight: 600 }}>
              {email.subject ?? item.title}
            </span>
          </div>
        </div>
        {editing ? (
          <textarea
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            style={{ ...textareaStyle, border: 'none', borderRadius: 0 }}
          />
        ) : (
          <div
            style={{
              padding: 16,
              fontSize: 13.5,
              color: 'var(--text-mid)',
              lineHeight: 1.7,
              whiteSpace: 'pre-wrap',
            }}
          >
            {body || '(aucun contenu)'}
          </div>
        )}
      </div>

      <PanelActions>
        <PanelButton
          variant="primary"
          disabled={resolving}
          onClick={() => onResolve({ approved: true, text: body })}
        >
          Envoyer
        </PanelButton>
        <PanelButton variant="secondary" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Aperçu' : 'Éditer'}
        </PanelButton>
        <PanelButton variant="danger" onClick={() => setRefuseOpen((v) => !v)}>
          Refuser
        </PanelButton>
      </PanelActions>

      {refuseOpen && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            border: '1px solid color-mix(in oklab, var(--sem-alert) 30%, transparent)',
            borderRadius: 'var(--r-md)',
            padding: '13px 14px',
            background: 'color-mix(in oklab, var(--sem-alert) 5%, transparent)',
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
            Motif du refus · renvoyé au communicant
          </span>
          <textarea
            rows={2}
            value={refuseReason}
            onChange={(e) => setRefuseReason(e.target.value)}
            placeholder="ex. ton trop insistant, attendre la fin du step…"
            style={{ ...textareaStyle, padding: '10px 12px' }}
          />
          <PanelButton
            variant="danger"
            disabled={resolving}
            style={{ alignSelf: 'flex-start', background: 'var(--sem-alert)', color: '#1A0A06' }}
            onClick={() => onResolve({ approved: false, text: refuseReason })}
          >
            Confirmer le refus
          </PanelButton>
        </div>
      )}
    </>
  )
}

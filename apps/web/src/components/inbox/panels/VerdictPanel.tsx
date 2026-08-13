import { PanelActions, PanelButton, SectionLabel } from '../PanelKit'
import type { PanelProps } from './types'

interface Ecart {
  sev: string
  txt: string
}

function readEcarts(payload: Record<string, unknown>): Ecart[] {
  const raw = payload.ecarts
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (e): e is Ecart =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as Ecart).sev === 'string' &&
      typeof (e as Ecart).txt === 'string',
  )
}

// Panneau « verdict » (Inbox.dc.html, sc-if selV). Les 3 captures d'écran
// (mobile/tablette/desktop) sont décoratives dans le prototype lui-même — de
// simples cadres, jamais de vraies images — on les reprend telles quelles :
// aucune donnée réelle n'existe encore pour elles (juge visuel = J8, hors
// périmètre).
const SHOTS = [
  { label: 'mobile · 375', ratio: '375 / 640' },
  { label: 'tablette · 768', ratio: '768 / 800' },
  { label: 'desktop · 1440', ratio: '1440 / 900' },
]

export function VerdictPanel({ item, resolving, onResolve, onClose }: PanelProps) {
  const ecarts = readEcarts(item.payload)
  const summary = typeof item.payload.summary === 'string' ? item.payload.summary : item.title

  return (
    <>
      <div style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6 }}>{summary}</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 2fr', gap: 10 }}>
        {SHOTS.map((s) => (
          <div key={s.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
              {s.label}
            </span>
            <div
              style={{
                aspectRatio: s.ratio,
                border: '1px solid var(--line-strong)',
                borderRadius: 'var(--r-sm)',
                background: 'linear-gradient(180deg, #16202F, #101826)',
                position: 'relative',
                overflow: 'hidden',
              }}
            />
          </div>
        ))}
      </div>

      {ecarts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>Écarts vs specs</SectionLabel>
          {ecarts.map((e, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: liste figée par le payload de l'item, jamais réordonnée
              key={i}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                border: '1px solid var(--line)',
                borderRadius: 'var(--r-md)',
                background: 'rgba(9, 14, 22, 0.5)',
                padding: '10px 12px',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  font: '600 9.5px var(--font-mono)',
                  letterSpacing: '0.1em',
                  color: e.sev === 'MINEUR' ? 'var(--sem-question)' : 'var(--sem-alert)',
                  border: `1px solid color-mix(in oklab, ${e.sev === 'MINEUR' ? 'var(--sem-question)' : 'var(--sem-alert)'} 35%, transparent)`,
                  borderRadius: 'var(--r-full)',
                  padding: '2px 8px',
                  marginTop: 1,
                }}
              >
                {e.sev}
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.5 }}>
                {e.txt}
              </span>
            </div>
          ))}
        </div>
      )}

      <PanelActions>
        <PanelButton
          variant="primary"
          disabled={resolving}
          onClick={() => onResolve({ verdict: 'accepted' })}
        >
          Valider le step
        </PanelButton>
        <PanelButton
          variant="secondary"
          disabled={resolving}
          onClick={() => onResolve({ verdict: 'iterate' })}
        >
          Relancer avec correctifs
        </PanelButton>
        {/* Comme le prototype : ce bouton referme le panneau sans résoudre
            l'item — corriger à la main se fait hors de l'inbox. */}
        <PanelButton variant="ghost" onClick={onClose}>
          Corriger à la main
        </PanelButton>
      </PanelActions>
    </>
  )
}

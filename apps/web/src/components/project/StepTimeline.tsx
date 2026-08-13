import type { StepView } from '../../lib/project-types'
import { STEP_OFFSETS, stepNumber, stepTone } from './steps'

/**
 * Timeline des steps de la vue d'ensemble (Projet.dc.html, `sc-for
 * list="{{ steps }}"` du bloc « Timeline des steps »). Pastilles décalées
 * verticalement, trait de liaison teinté quand le step précédent est terminé,
 * défilement horizontal au-delà de la largeur disponible.
 */
export function StepTimeline({
  steps,
  runningIteration,
}: {
  steps: StepView[]
  /** Itération du run courant, portée par le seul step en cours. */
  runningIteration: [number, number] | null
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span
        style={{
          font: '600 10.5px var(--font-mono)',
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--text-mid)',
        }}
      >
        Timeline des steps
      </span>
      {steps.length === 0 ? (
        <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
          aucun step défini · le projet attend son découpage
        </span>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 0,
            overflowX: 'auto',
            padding: '4px 2px 8px',
          }}
        >
          {steps.map((s, i) => {
            const tone = stepTone(s, s.status === 'running' ? runningIteration : null)
            return (
              <div
                key={s.id}
                style={{ display: 'flex', alignItems: 'flex-start', flex: 1, minWidth: 118 }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 7,
                    alignItems: 'flex-start',
                    width: '100%',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      width: '100%',
                      marginTop: STEP_OFFSETS[i % STEP_OFFSETS.length],
                    }}
                  >
                    <span
                      style={{
                        width: tone.dotSize,
                        height: tone.dotSize,
                        flexShrink: 0,
                        borderRadius: 999,
                        background: tone.dotFill,
                        boxShadow: tone.dotGlow,
                        animation: tone.dotAnim,
                      }}
                    />
                    <span style={{ flex: 1, height: 1, background: tone.lineBg, opacity: 0.8 }} />
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      paddingRight: 14,
                    }}
                  >
                    <span style={{ font: '600 10px var(--font-mono)', color: 'var(--text-low)' }}>
                      {stepNumber(s.position)}
                    </span>
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 500,
                        color: tone.nameColor,
                        lineHeight: 1.3,
                      }}
                    >
                      {s.title}
                    </span>
                    <span style={{ font: '10.5px var(--font-mono)', color: tone.color }}>
                      {tone.label}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

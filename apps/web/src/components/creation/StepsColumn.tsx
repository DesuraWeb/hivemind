import type { CSSProperties } from 'react'
import type { StepDraft } from './draft'
import { FRAGMENT_LABEL, GLASS_ROW } from './kit'

const TITLE_INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'transparent',
  border: 'none',
  font: '500 13.5px var(--font-sans)',
  color: 'var(--text-hi)',
  outline: 'none',
  padding: 0,
}

const SPECS_INPUT: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'transparent',
  border: 'none',
  borderTop: '1px solid var(--line)',
  paddingTop: 8,
  font: '11.5px var(--font-mono)',
  color: 'var(--text-mid)',
  outline: 'none',
  lineHeight: 1.5,
  resize: 'none',
}

const GHOST_BUTTON: CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  font: '500 11px var(--font-mono)',
  color: 'var(--text-low)',
  padding: '4px 2px',
}

function clampIterations(raw: string, current: number): number {
  const digits = raw.replace(/\D/g, '')
  if (digits === '') return current
  return Math.min(20, Math.max(1, Number(digits)))
}

/**
 * Fragment « Steps » (pack : colonne de droite en mode projet, stage 2).
 *
 * Deux écarts avec le prototype, tous les deux pour que la carte fasse ce
 * qu'elle montre :
 *
 * - une deuxième ligne de **specs** par step. Le serveur les exige (`specs`
 *   non vide) et il a raison : un step sans specs est un step qu'aucun agent
 *   ne peut prendre. Les recopier depuis l'intitulé aurait rempli la colonne
 *   d'un doublon présenté comme un cahier des charges.
 * - le badge `full-auto` / `gates` et le compteur d'itérations sont
 *   **cliquables**. Le pack les montre décidés par Hive ; personne ne les
 *   décide aujourd'hui, et ces deux champs partent vraiment dans
 *   `POST /api/projects` — les laisser décoratifs aurait enregistré `gates` et
 *   4 itérations quoi qu'affiche l'écran.
 */
export function StepsColumn({
  style,
  revealed,
  steps,
  onPatch,
  onAdd,
  onRemove,
}: {
  style: CSSProperties
  revealed: boolean
  steps: StepDraft[]
  onPatch: (id: string, patch: Partial<StepDraft>) => void
  onAdd: () => void
  onRemove: (id: string) => void
}) {
  return (
    <div style={{ ...style, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span
        style={{
          ...FRAGMENT_LABEL,
          opacity: revealed ? 1 : 0,
          transition: 'opacity 500ms var(--ease)',
          padding: '0 2px',
        }}
      >
        Steps · boucles réglées par vous
      </span>

      {steps.map((step, i) => {
        const num = String(i + 1).padStart(2, '0')
        const loopColor = step.auto ? 'var(--accent)' : 'var(--text-low)'
        return (
          <div
            key={step.id}
            style={{
              ...GLASS_ROW,
              opacity: revealed ? 1 : 0,
              transform: revealed ? 'translateX(0px)' : 'translateX(18px)',
              transition: 'opacity 550ms var(--ease), transform 550ms var(--ease-out)',
              transitionDelay: `${i * 110}ms`,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '12px 16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ font: '600 12px var(--font-mono)', color: 'var(--text-low)' }}>
                {num}
              </span>
              <input
                className="creation-field"
                value={step.title}
                onChange={(e) => onPatch(step.id, { title: e.target.value })}
                placeholder="intitulé du step"
                aria-label={`Intitulé du step ${num}`}
                style={TITLE_INPUT}
              />
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  font: '10.5px var(--font-mono)',
                  color: 'var(--text-low)',
                  whiteSpace: 'nowrap',
                }}
              >
                it.
                <input
                  className="creation-field"
                  value={String(step.iterations)}
                  onChange={(e) =>
                    onPatch(step.id, {
                      iterations: clampIterations(e.target.value, step.iterations),
                    })
                  }
                  inputMode="numeric"
                  aria-label={`Itérations maximum du step ${num}`}
                  title="itérations dev ↔ reviewer avant remontée en inbox"
                  style={{
                    width: 20,
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid var(--line)',
                    padding: 0,
                    textAlign: 'center',
                    font: '10.5px var(--font-mono)',
                    color: 'var(--text-mid)',
                    outline: 'none',
                  }}
                />
              </span>
              <button
                type="button"
                onClick={() => onPatch(step.id, { auto: !step.auto })}
                aria-pressed={step.auto}
                title="full-auto ne porte que sur l'itération dev ↔ reviewer · la mise en prod reste un gate"
                style={{
                  font: '600 9.5px var(--font-mono)',
                  letterSpacing: '0.08em',
                  color: loopColor,
                  background: 'transparent',
                  border: `1px solid color-mix(in oklab, ${loopColor} 35%, transparent)`,
                  borderRadius: 'var(--r-full)',
                  padding: '2px 7px',
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                }}
              >
                {step.auto ? 'full-auto' : 'gates'}
              </button>
              {steps.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemove(step.id)}
                  aria-label={`Retirer le step ${num}`}
                  style={{ ...GHOST_BUTTON, padding: '0 0 0 2px' }}
                >
                  ×
                </button>
              )}
            </div>
            <textarea
              className="creation-field"
              value={step.specs}
              onChange={(e) => onPatch(step.id, { specs: e.target.value })}
              placeholder="specs · ce que le step doit produire, et à quoi on le juge"
              aria-label={`Specs du step ${num}`}
              rows={2}
              style={SPECS_INPUT}
            />
          </div>
        )
      })}

      <button
        type="button"
        onClick={onAdd}
        className="creation-ghost"
        style={{
          ...GHOST_BUTTON,
          opacity: revealed ? 1 : 0,
          transition: 'opacity 500ms var(--ease)',
          alignSelf: 'flex-start',
        }}
      >
        + ajouter un step
      </button>
    </div>
  )
}

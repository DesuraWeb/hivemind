import type { RunView, StepView } from '../../lib/project-types'
import { formatRunTime, runTone, shortRunId } from './runs'
import { formatTokens, stepNumber } from './steps'

/**
 * Onglet « Boucles » (Projet.dc.html, `sc-if value="{{ isBoucles }}"`).
 *
 * Écart assumé au pack : dans le prototype chaque ligne ouvre un tiroir plein
 * écran avec la piste d'audit du run (garant → dev → reviewer → juge, prompts
 * dépliables, diffs, screenshots). Ce tiroir n'est pas ici — hors du périmètre
 * de cet écran, il relève de « Run en direct.dc.html ». `GET /api/runs/:id`
 * (arrivé pendant l'écriture de cette page) en rendrait la matière : c'est le
 * point de départ tout trouvé, pas une impasse. En attendant, les lignes sont
 * informatives et non cliquables plutôt que cliquables vers du vide.
 *
 * Le coût est affiché en tokens seulement, jamais converti en euros : le taux
 * (`pricing.eur_per_mtok`) est un réglage serveur, le recopier ici en
 * créerait une seconde source de vérité qui dériverait au premier changement.
 */
export function RunsList({ runs, steps }: { runs: RunView[]; steps: StepView[] }) {
  if (runs.length === 0) {
    return (
      <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
        aucune boucle jouée sur ce projet
      </span>
    )
  }

  const stepById = new Map(steps.map((s) => [s.id, s]))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 900 }}>
      {runs.map((r) => {
        const tone = runTone(r.state)
        const step = stepById.get(r.stepId)
        const title = step
          ? `Step ${stepNumber(step.position)} · itération ${r.iteration} · ${step.title}`
          : `itération ${r.iteration}`
        return (
          <div
            key={r.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '12px 15px',
              borderRadius: 'var(--r-md)',
              border: '1px solid var(--line)',
              background: 'var(--bg-1)',
              boxSizing: 'border-box',
              width: '100%',
            }}
          >
            <span style={{ font: '500 12px var(--font-mono)', color: 'var(--accent)', width: 92 }}>
              {shortRunId(r.id)}
            </span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--text-hi)',
                flex: 1,
                minWidth: 0,
              }}
            >
              {title}
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                font: '10.5px var(--font-mono)',
                color: 'var(--text-mid)',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: 999,
                  background: tone.color,
                  animation: tone.pulse ? 'chapoPulse 1.8s var(--ease) infinite' : 'none',
                }}
              />
              {tone.label}
            </span>
            <span
              style={{
                font: '11px var(--font-mono)',
                color: 'var(--text-low)',
                width: 150,
                textAlign: 'right',
              }}
            >
              {formatRunTime(r.startedAt)} · {formatTokens(r.costTokens)} tok
            </span>
          </div>
        )
      })}
      <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)', padding: '6px 2px' }}>
        piste d&rsquo;audit détaillée d&rsquo;un run · écran « run en direct », pas encore branché
      </span>
    </div>
  )
}

import type { RunView, StepView } from '../../lib/project-types'
import { Markdown } from '../Markdown'
import { StartLoop } from '../run/StartLoop'
import { isRunActive } from './runs'
import { stepNumber, stepTone } from './steps'

/**
 * Onglet « Steps » (Projet.dc.html, `sc-if value="{{ isSteps }}"`) : une carte
 * par step, specs, régime de validation — et le bouton qui lance la boucle.
 *
 * C'est ici que le geste « démarrer » a sa place : le step est l'unité qu'un
 * run traite, et la carte porte déjà les specs qu'on relit avant de lancer.
 * Un step déjà occupé n'affiche pas de bouton mais le lien vers sa boucle en
 * direct — `runs` est passé pour ça, et pour rien d'autre.
 *
 * Écart assumé au pack : le prototype rend « Gates humaines » / « Full-auto »
 * en boutons, avec un maintien de 1,1 s pour basculer en full-auto. Aucune
 * route ne permet aujourd'hui de changer `steps.autonomy` — un bouton qui ne
 * change rien serait pire qu'un état lisible. Les deux pastilles sont donc
 * rendues en lecture seule, avec exactement le même vocabulaire visuel
 * (celle qui est active porte sa couleur, l'autre reste éteinte).
 */
export function StepList({
  steps,
  runs,
  projectId,
}: {
  steps: StepView[]
  runs: RunView[]
  projectId: string
}) {
  if (steps.length === 0) {
    return (
      <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
        aucun step défini · le projet attend son découpage
      </span>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 900 }}>
      {steps.map((s) => {
        const tone = stepTone(s)
        const isAuto = s.autonomy === 'auto'
        // `runs` est trié du plus récent au plus ancien : le premier run non
        // terminal de ce step est celui qui l'occupe.
        const activeRun = runs.find((r) => r.stepId === s.id && isRunActive(r.state)) ?? null
        return (
          <div
            key={s.id}
            style={{
              border: '1px solid var(--line)',
              borderLeft: `3px solid ${tone.color}`,
              borderRadius: 'var(--r-md)',
              background: 'var(--bg-1)',
              padding: '14px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ font: '600 11px var(--font-mono)', color: 'var(--text-low)' }}>
                {stepNumber(s.position)}
              </span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{s.title}</span>
              <span style={{ font: '10.5px var(--font-mono)', color: tone.color }}>
                {tone.label}
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  font: '11px var(--font-mono)',
                  color: 'var(--text-low)',
                }}
              >
                max_iterations {s.maxIterations}
              </span>
            </div>

            {/*
              `steps.specs` est déclaré `md` depuis la première migration.
              L'écran affichait la chaîne BRUTE : un pavé de prose où les
              critères d'acceptation se noyaient dans la description.
            */}
            <Markdown texte={s.specs} style={{ fontSize: 12.5, color: 'var(--text-mid)' }} />

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                flexWrap: 'wrap',
                borderTop: '1px solid var(--line)',
                paddingTop: 11,
              }}
            >
              <span
                style={{
                  font: '600 10px var(--font-sans)',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--text-low)',
                }}
              >
                Validation
              </span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '5px 12px',
                  borderRadius: 'var(--r-full)',
                  border: `1px solid ${isAuto ? 'var(--line-strong)' : 'color-mix(in oklab, var(--accent) 45%, transparent)'}`,
                  background: isAuto
                    ? 'transparent'
                    : 'color-mix(in oklab, var(--accent) 12%, transparent)',
                  color: isAuto ? 'var(--text-mid)' : 'var(--text-hi)',
                  font: '500 12px var(--font-sans)',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path
                    d="M6 1.5a3 3 0 0 1 3 3V6H3V4.5a3 3 0 0 1 3-3zM2.5 6h7a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"
                    stroke="currentColor"
                    strokeWidth="1.1"
                  />
                </svg>
                Gates humaines
              </span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '5px 12px',
                  borderRadius: 'var(--r-full)',
                  border: `1px solid ${isAuto ? 'color-mix(in oklab, var(--sem-question) 50%, transparent)' : 'var(--line-strong)'}`,
                  background: isAuto
                    ? 'color-mix(in oklab, var(--sem-question) 13%, transparent)'
                    : 'transparent',
                  color: isAuto ? 'var(--text-hi)' : 'var(--text-mid)',
                  font: '500 12px var(--font-sans)',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path
                    d="M6.8 1L2.5 6.8h3L5.2 11l4.3-5.8h-3L6.8 1z"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinejoin="round"
                  />
                </svg>
                Full-auto
              </span>
              {isAuto && (
                <span style={{ font: '10.5px var(--font-mono)', color: 'var(--sem-question)' }}>
                  aucune validation humaine sur ce step
                </span>
              )}
              {s.autonomy === null && (
                <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
                  régime hérité du projet
                </span>
              )}
              <span style={{ marginLeft: 'auto' }}>
                <StartLoop step={s} activeRun={activeRun} projectId={projectId} />
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

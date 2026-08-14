import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Note, SectionTitle, formatEur, formatTokensShort } from './kit'

/**
 * « Coût par step » du projet sélectionné.
 *
 * **Jamais par itération.** `runs.cost_tokens` est un cumul sur tout le run,
 * itérations comprises, et rien n'enregistre le détail par tour
 * (`apps/server/src/analytics/repo.ts`). La phrase du pack « l'itération de
 * trop se voit immédiatement » promet une granularité qui n'existe pas : elle
 * est remplacée par ce que l'écran sait dire.
 *
 * Un step jamais lancé apparaît à 0 (le `coalesce` du serveur est délibéré) :
 * c'est une information, pas un trou. Le step le plus cher est mis en avant —
 * c'est une lecture de la colonne, pas un drapeau posé à la main comme le
 * `hot: true` de la fixture.
 */

export interface StepCostsProps {
  /** Slug du projet, ou `null` quand aucun projet n'a consommé sur la fenêtre. */
  projectId: string | null
  projectName: string | null
}

export function StepCosts({ projectId, projectName }: StepCostsProps) {
  const stepsQuery = useQuery({
    queryKey: ['analytics', 'steps', projectId] as const,
    queryFn: () => api.analytics.steps(projectId as string),
    enabled: projectId !== null,
  })

  const steps = stepsQuery.data ?? []
  const maxTokens = steps.reduce((m, s) => Math.max(m, s.tokens), 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ paddingBottom: 10 }}>
        <SectionTitle>{projectName ?? 'Projet'} · coût par step</SectionTitle>
      </div>

      {projectId === null && <Note>sélectionnez un projet à gauche</Note>}
      {projectId !== null && stepsQuery.isPending && <Note>lecture des steps…</Note>}
      {projectId !== null && stepsQuery.isError && (
        <span style={{ font: '10.5px var(--font-mono)', color: 'var(--sem-alert)' }}>
          coût par step injoignable
        </span>
      )}
      {projectId !== null && stepsQuery.isSuccess && steps.length === 0 && (
        <Note>ce projet n&rsquo;a aucun step</Note>
      )}

      {steps.map((s) => {
        const hottest = maxTokens > 0 && s.tokens === maxTokens
        return (
          <div
            key={s.position}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 2px',
              borderBottom: '1px solid var(--line)',
              font: '12px var(--font-mono)',
            }}
          >
            <span style={{ color: 'var(--text-low)' }}>{String(s.position).padStart(2, '0')}</span>
            <span
              style={{
                color: 'var(--text-hi)',
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                fontWeight: 500,
                flex: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {s.title}
            </span>
            <span
              style={{
                color: hottest ? 'var(--sem-question)' : 'var(--text-mid)',
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}
              title={`${s.tokens.toLocaleString('fr-FR')} tokens`}
            >
              {s.tokens === 0
                ? 'jamais lancé'
                : `${formatEur(s.eur)} · ${formatTokensShort(s.tokens)}`}
            </span>
          </div>
        )
      })}

      {steps.length > 0 && (
        <div style={{ paddingTop: 10 }}>
          <Note>
            coût par step, jamais par itération : la conso est cumulée sur tout le run, rien
            n&rsquo;enregistre le détail par tour
          </Note>
        </div>
      )}
    </div>
  )
}

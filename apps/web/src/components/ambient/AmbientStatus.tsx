import { useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { api } from '../../lib/api'
import type { ProjectView } from '../../lib/project-types'

const LINE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  font: '12px var(--font-mono)',
  color: 'var(--text-mid)',
}

function Dot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        background: color,
        flexShrink: 0,
        animation: pulse ? 'chapoPulse 1.8s var(--ease) infinite' : 'none',
      }}
    />
  )
}

/**
 * La jauge de budget, réduite à une ligne (`Ambient.dc.html` : « fenêtre 5 h ·
 * 62 % »). Même règle que `BudgetPanel` : `gauge: null` s'affiche « inconnue »,
 * jamais un pourcentage rassurant tiré de rien.
 */
function BudgetLine() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['budget'],
    queryFn: api.budget.get,
    refetchInterval: 60_000,
  })

  if (isPending) return <span style={{ ...LINE, color: 'var(--text-low)' }}>budget · mesure…</span>
  if (isError) {
    return (
      <span style={{ ...LINE, color: 'var(--text-low)' }}>
        <Dot color="var(--pause)" />
        budget · jauge injoignable
      </span>
    )
  }
  if (!data.gauge) {
    return (
      <span style={{ ...LINE, color: 'var(--text-low)' }}>
        <Dot color="var(--pause)" />
        fenêtre 5 h · inconnue
      </span>
    )
  }
  const over = data.gauge.fiveHourPct >= data.thresholds.pause
  return (
    <span style={{ ...LINE, color: over ? 'var(--sem-alert)' : 'var(--text-low)' }}>
      <Dot color={over ? 'var(--sem-alert)' : 'var(--pause)'} />
      fenêtre 5 h · {data.gauge.fiveHourPct} %{data.gauge.known ? '' : ' · mesure périmée'}
    </span>
  )
}

/**
 * Ce que l'écran sait d'une liste. Un `0` affiché pendant le chargement ou
 * après un échec serait une affirmation — « aucune boucle active », « aucune
 * décision » — que personne n'a vérifiée : les trois cas restent distincts
 * jusqu'à l'affichage.
 */
export type Known<T> = { state: 'pending' } | { state: 'error' } | { state: 'ok'; value: T }

export interface AmbientStatusProps {
  projects: Known<ProjectView[]>
  /** Nombre de décisions ouvertes dans l'inbox. */
  decisions: Known<number>
}

/**
 * Les indicateurs flottants du coin haut droit (`Ambient.dc.html`) : boucles
 * actives, décisions en attente, fenêtre de budget. Sans fond ni bordure,
 * comme partout ailleurs (CLAUDE.md : pas de top bar).
 */
export function AmbientStatus({ projects, decisions }: AmbientStatusProps) {
  const running = projects.state === 'ok' ? projects.value.filter((p) => p.loop === 'run') : []
  const only = running.length === 1 ? running[0] : null
  const active = projects.state === 'ok' && running.length > 0

  return (
    <div
      style={{
        position: 'absolute',
        right: 40,
        top: 40,
        zIndex: 2,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 10,
        pointerEvents: 'none',
        maxWidth: '46vw',
        textAlign: 'right',
      }}
    >
      <span style={{ ...LINE, color: active ? 'var(--text-mid)' : 'var(--text-low)' }}>
        <Dot color={active ? 'var(--accent)' : 'var(--pause)'} pulse={active} />
        {projects.state === 'pending'
          ? 'boucles · lecture en cours…'
          : projects.state === 'error'
            ? 'boucles · liste injoignable'
            : `${running.length} boucle${running.length > 1 ? 's' : ''} active${
                running.length > 1 ? 's' : ''
              }${only ? ` · ${only.name} · ${only.line}` : ''}`}
      </span>

      <span
        style={{
          ...LINE,
          color:
            decisions.state === 'ok' && decisions.value > 0 ? 'var(--text-mid)' : 'var(--text-low)',
        }}
      >
        <Dot
          color={
            decisions.state === 'ok' && decisions.value > 0 ? 'var(--sem-question)' : 'var(--pause)'
          }
        />
        {decisions.state === 'pending'
          ? 'décisions · lecture en cours…'
          : decisions.state === 'error'
            ? 'décisions · inbox injoignable'
            : decisions.value === 0
              ? 'aucune décision en attente'
              : `${decisions.value} décision${decisions.value > 1 ? 's' : ''} en attente`}
      </span>

      <BudgetLine />
    </div>
  )
}

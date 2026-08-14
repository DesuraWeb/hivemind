import { useQuery } from '@tanstack/react-query'
import type { BudgetView } from '../../lib/api'
import { api } from '../../lib/api'
import { Note, Panel, StatusLine } from './Panel'

/**
 * Une fenêtre de consommation, avec la zone de réserve hachurée à droite —
 * la barre du pack (`Reglages.dc.html`), aux vraies valeurs.
 */
function Gauge({
  label,
  pct,
  reservePct,
  pausePct,
}: {
  label: string
  pct: number
  reservePct: number
  pausePct: number
}) {
  const over = pct >= pausePct
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span
          style={{
            font: '600 10.5px var(--font-mono)',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--text-mid)',
          }}
        >
          {label}
        </span>
        <span
          style={{
            font: '11.5px var(--font-mono)',
            color: over ? 'var(--sem-alert)' : 'var(--text-mid)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {pct} % · pause à {pausePct} %
        </span>
      </div>
      <div
        style={{
          position: 'relative',
          height: 8,
          background: 'var(--bg-2)',
          border: '1px solid var(--line)',
          borderRadius: 999,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: `${Math.min(100, Math.max(0, pct))}%`,
            background: over
              ? 'var(--sem-alert)'
              : 'linear-gradient(90deg, color-mix(in oklab, var(--accent) 55%, transparent), var(--accent))',
            borderRadius: 999,
            transition: 'width var(--dur-2) var(--ease)',
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            right: 0,
            width: `${Math.min(100, Math.max(0, reservePct))}%`,
            borderLeft: '1px dashed var(--line-strong)',
            background:
              'repeating-linear-gradient(135deg, rgba(160, 180, 210, 0.10) 0 3px, transparent 3px 7px)',
            borderRadius: '0 999px 999px 0',
          }}
        />
      </div>
    </div>
  )
}

function ReserveLines({ data }: { data: BudgetView }) {
  const entamee = data.reserve.state === 'entamee'
  const until = data.reserve.until
    ? new Date(data.reserve.until).toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null
  const reset = data.resetsAt
    ? new Date(data.resetsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <>
      <StatusLine color={entamee ? 'var(--sem-alert)' : 'var(--ok)'}>
        réserve {data.reserve.pct} points ·{' '}
        {entamee
          ? `entamée${until ? ` jusqu’à ${until}` : ''} · le seuil de pause ne s’applique plus`
          : `intacte · pause automatique à ${data.thresholds.pauseNominal} %, reprise sous ${data.thresholds.resume} %`}
      </StatusLine>
      {reset ? (
        <StatusLine color="var(--text-low)">remise à zéro de la fenêtre · {reset}</StatusLine>
      ) : (
        <StatusLine color="var(--text-low)">
          heure de remise à zéro · non rendue par le runtime
        </StatusLine>
      )}
    </>
  )
}

/**
 * Budget et réserve (`Reglages.dc.html`, bloc « Budget global & réserve »),
 * en lecture. Le pack affiche des **plafonds en tokens** (« 5,0 M tokens »,
 * « conso 3,1 M / 5,0 M ») : le compte Claude n'expose que des pourcentages de
 * fenêtre, aucun volume. Ces champs ne sont pas rendus à zéro, ils sont
 * absents — et ce qui est réellement réglable (la réserve, le seuil de
 * reprise) vit dans le panneau suivant.
 */
export function BudgetSection() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['budget'],
    queryFn: api.budget.get,
    // Mesure gratuite côté serveur, mais c'est un appel réseau : même cadence
    // que le dashboard, pas plus vite que l'échantillonnage du scheduler.
    refetchInterval: 60_000,
  })

  return (
    <Panel label="Budget · jauge et réserve">
      {isPending && <Note>mesure en cours…</Note>}
      {isError && <Note>jauge injoignable · réessai automatique</Note>}

      {data && !data.gauge && (
        <>
          <StatusLine color="var(--sem-question)">jauge inconnue · {data.reason}</StatusLine>
          <Note>
            aucune boucle n&rsquo;est mise en pause tant que la jauge est muette · la réserve
            n&rsquo;est plus protégée, et un item d&rsquo;inbox le signale quand une boucle tourne
          </Note>
        </>
      )}

      {data?.gauge && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Gauge
            label="Fenêtre 5 h"
            pct={data.gauge.fiveHourPct}
            reservePct={data.reserve.pct}
            pausePct={data.thresholds.pause}
          />
          <Gauge
            label="Fenêtre 7 j"
            pct={data.gauge.sevenDayPct}
            reservePct={data.reserve.pct}
            pausePct={data.thresholds.pause}
          />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <ReserveLines data={data} />
            {!data.gauge.known && (
              <StatusLine color="var(--sem-question)">
                mesure périmée{data.gauge.ageMinutes !== null && ` (${data.gauge.ageMinutes} min)`}{' '}
                · {data.reason}
              </StatusLine>
            )}
          </div>
          <Note>
            zone hachurée : la réserve · les boucles se mettent en pause avant d&rsquo;y toucher
          </Note>
        </div>
      )}

      <Note>
        le compte ne rend que des pourcentages de fenêtre · aucun volume de tokens n&rsquo;est
        disponible, il n&rsquo;y a donc pas de plafond en tokens à afficher ni à régler
      </Note>
    </Panel>
  )
}

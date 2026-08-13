import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

/**
 * La jauge de budget du dashboard (`BUDGET` de `docs/design/data.js`).
 *
 * Ce panneau affichait « Suivi budgétaire indisponible · prévu en J12 ». Le
 * suivi existe depuis que `usage()` mesure la vraie consommation, et « J12 »
 * renvoyait à un calendrier abandonné. C'était devenu un mensonge à l'écran.
 *
 * La règle qui gouverne l'affichage : **jamais un zéro rassurant à la place
 * d'une mesure absente.** Une jauge indisponible s'affiche « inconnu », une
 * mesure périmée le dit — c'est exactement ce que le serveur distingue déjà
 * (`gauge: null` contre `gauge.known: false`), et l'écran ne doit pas aplatir
 * cette distinction.
 */

/** Barre à deux fenêtres, comme le pack : 5 h au-dessus, 7 j en dessous. */
function Gauge({ label, pct, threshold }: { label: string; pct: number; threshold: number }) {
  const over = pct >= threshold
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span>{label}</span>
        <span
          style={{
            color: over ? 'var(--sem-alert)' : 'var(--text-mid)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {pct} %
        </span>
      </div>
      <div
        style={{
          height: 3,
          borderRadius: 999,
          background: 'rgba(214, 228, 247, 0.08)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.min(100, pct)}%`,
            height: '100%',
            borderRadius: 999,
            background: over ? 'var(--sem-alert)' : 'var(--accent)',
            transition: 'width var(--dur-2) var(--ease)',
          }}
        />
      </div>
    </div>
  )
}

export function BudgetPanel() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['budget'],
    queryFn: api.budget.get,
    // La mesure est gratuite côté serveur, mais c'est un appel réseau : on ne
    // la rafraîchit pas plus vite que le scheduler ne l'échantillonne.
    refetchInterval: 60_000,
  })

  const mono = { font: '11px var(--font-mono)', color: 'var(--text-low)' } as const

  if (isPending) return <div style={{ paddingTop: 10, ...mono }}>mesure en cours…</div>
  if (isError) {
    return <div style={{ paddingTop: 10, ...mono }}>jauge injoignable · réessai automatique</div>
  }

  if (!data.gauge) {
    // Le runtime n'expose pas la consommation (clé API, Bedrock, Vertex, ou
    // API indisponible). Le scheduler ne met alors jamais rien en pause : le
    // dire, plutôt que d'afficher une barre vide qui rassurerait à tort.
    return (
      <div style={{ paddingTop: 10, ...mono }}>
        jauge inconnue · {data.reason} · aucune pause automatique tant qu&rsquo;elle l&rsquo;est
      </div>
    )
  }

  const reset = data.resetsAt
    ? new Date(data.resetsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : null
  const entamee = data.reserve.state === 'entamee'

  return (
    <div style={{ paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10, ...mono }}>
      <Gauge label="fenêtre 5 h" pct={data.gauge.fiveHourPct} threshold={data.thresholds.pause} />
      <Gauge label="fenêtre 7 j" pct={data.gauge.sevenDayPct} threshold={data.thresholds.pause} />

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span
          style={{ color: entamee ? 'var(--sem-alert)' : 'var(--text-low)' }}
          title={
            entamee
              ? 'Le seuil de pause ne s’applique plus jusqu’à l’échéance.'
              : `Pause automatique à ${data.thresholds.pauseNominal} %.`
          }
        >
          réserve {data.reserve.pct} pts · {entamee ? 'entamée' : 'intacte'}
        </span>
        {reset && <span>remise à zéro · {reset}</span>}
      </div>

      {/* Une mesure périmée reste affichée, mais jamais comme une mesure
          fraîche : le serveur l'a déjà majorée pour décider, l'écran doit dire
          pourquoi le chiffre a bougé sans qu'il ne se passe rien. */}
      {!data.gauge.known && <span style={{ color: 'var(--sem-question)' }}>{data.reason}</span>}
    </div>
  )
}

import { Link } from '@tanstack/react-router'

/**
 * Panneau de verre flottant sur l'orbe (Dashboard.dc.html : « Brief du
 * matin »). Le prototype affiche une phrase rédigée par Hive (BRIEF_MATIN de
 * data.js) — rien d'équivalent n'existe côté serveur cette phase (le
 * communicant/Hive qui rédigerait ce texte est J10+, hors périmètre Task 8).
 * `summary` est donc un résumé CALCULÉ à partir des vrais compteurs d'inbox
 * (nombre de décisions ouvertes, âge de la plus ancienne) — jamais une phrase
 * inventée pour ressembler à de la prose Hive.
 */
export function BriefPanel({ summary, time }: { summary: string; time: string }) {
  return (
    <div
      style={{
        borderRadius: 'var(--r-lg)',
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
        WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
        border: '1px solid var(--glass-border)',
        boxShadow: 'var(--shadow-2), inset 0 1px 0 rgba(255, 255, 255, 0.10)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <span
          style={{
            font: '600 10.5px var(--font-mono)',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--text-mid)',
          }}
        >
          Brief du matin
        </span>
        <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>{time}</span>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 12.5,
          fontWeight: 500,
          lineHeight: 1.65,
          color: 'var(--text-mid)',
          textWrap: 'pretty',
        }}
      >
        {summary}
      </p>
      <div style={{ display: 'flex', gap: 14, paddingTop: 2 }}>
        <Link to="/inbox" style={{ font: '500 12px var(--font-sans)' }}>
          Ouvrir l&rsquo;inbox →
        </Link>
      </div>
    </div>
  )
}

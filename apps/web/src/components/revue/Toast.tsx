/**
 * Le bandeau de confirmation flottant (`Revue du matin.dc.html`, `toast`).
 *
 * Deux tons : `ok` pour ce qui est fait, `neutre` pour un raccourci sans
 * effet (rien à reporter, action principale indisponible) — un retour est dû
 * dans les deux cas, sinon une touche qui ne fait rien passe pour une panne.
 */
export function Toast({ text, tone }: { text: string | null; tone: 'ok' | 'neutre' }) {
  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        // Le prototype pose le bandeau à 52 px du bas parce que son
        // MajordomeStrip est dans le flux, au-dessus. Ici le strip est commun
        // à tous les écrans et flotte en absolu à 12 px du bas sur ~120 px de
        // haut : à 52 px, le bandeau se poserait dessus. Il monte donc au-dessus
        // du strip ET de la légende des raccourcis, qu'il masquerait sinon —
        // une légende clavier cachée par un message est exactement ce dont un
        // écran piloté au clavier n'a pas besoin.
        bottom: 196,
        transform: `translateX(-50%) translateY(${text ? '0' : '14px'})`,
        opacity: text ? 1 : 0,
        zIndex: 70,
        transition: 'all var(--dur-3) var(--ease-out)',
        pointerEvents: 'none',
      }}
      // `aria-live` sans `role="status"` : l'élément sémantique équivalent
      // (`<output>`) est en ligne et ne porte pas ce positionnement fixe.
      aria-live="polite"
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          borderRadius: 'var(--r-lg)',
          background: 'var(--glass-bg)',
          WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
          backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
          border: '1px solid var(--glass-border)',
          boxShadow: 'var(--shadow-1)',
          whiteSpace: 'nowrap',
        }}
      >
        {tone === 'ok' ? (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <circle cx="7.5" cy="7.5" r="6.5" stroke="var(--ok)" strokeWidth="1.3" />
            <path
              d="M4.8 7.7l1.8 1.8 3.6-4"
              stroke="var(--ok)"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <circle cx="7.5" cy="7.5" r="6.5" stroke="var(--text-low)" strokeWidth="1.3" />
            <path d="M7.5 4.4v4" stroke="var(--text-low)" strokeWidth="1.3" strokeLinecap="round" />
            <circle cx="7.5" cy="10.6" r="0.8" fill="var(--text-low)" />
          </svg>
        )}
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-hi)' }}>{text}</span>
      </div>
    </div>
  )
}

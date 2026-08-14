import { Link } from '@tanstack/react-router'

/**
 * L'écran de fin (`Revue du matin.dc.html`, `sc-if finished`).
 *
 * Le pack écrit « toutes les boucles tournent » sous le compteur. C'est une
 * affirmation sur l'état du système, pas sur la revue : rien ne garantit
 * qu'une boucle tourne parce que l'inbox est vide (un projet peut n'avoir
 * aucun run, un run peut être en pause budget). La ligne dit donc ce que
 * `GET /api/projects` rend vraiment — combien de boucles sont en cours — et
 * ne dit rien quand on ne le sait pas encore.
 */

export interface DoneScreenProps {
  /** Décisions traitées pendant CETTE revue, pas depuis toujours. */
  done: number
  clock: string
  /** Boucles en cours (`loop === 'run'`), ou `null` tant que les projets ne sont pas chargés. */
  running: number | null
}

const linkBase = {
  padding: '10px 20px',
  borderRadius: 'var(--r-md)',
  font: '600 13.5px var(--font-sans)',
  textDecoration: 'none',
} as const

export function DoneScreen({ done, clock, running }: DoneScreenProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
        textAlign: 'center',
      }}
    >
      <svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true">
        <circle cx="22" cy="22" r="19" stroke="var(--ok)" strokeWidth="1.6" />
        <path
          d="M14 22.5l5.4 5.4L30.5 16"
          stroke="var(--ok)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div style={{ fontSize: 24, fontWeight: 600 }}>Inbox à zéro</div>
      <div style={{ font: '12.5px var(--font-mono)', color: 'var(--text-mid)', lineHeight: 1.7 }}>
        {done === 0
          ? `rien à traiter · revue ouverte depuis ${clock}`
          : `${done} décision${done > 1 ? 's' : ''} · ${clock}`}
        <br />
        {running === null
          ? 'état des boucles en cours de lecture'
          : running === 0
            ? 'aucune boucle en cours'
            : `${running} boucle${running > 1 ? 's' : ''} en cours`}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 8 }}>
        <Link
          to="/"
          style={{ ...linkBase, background: 'var(--accent)', color: 'var(--accent-ink)' }}
        >
          Retour au dashboard
        </Link>
        <Link
          to="/journal"
          style={{
            ...linkBase,
            padding: '10px 16px',
            border: '1px solid var(--line-strong)',
            color: 'var(--text-hi)',
            fontWeight: 500,
            fontSize: 13,
          }}
        >
          Journal de nuit
        </Link>
      </div>
    </div>
  )
}

import type { ReactNode } from 'react'

// Label de section en mono petites caps espacées (0.16-0.18em, --text-mid),
// flottant en haut du contenu sans fond ni bordure — pas de top bar
// (CLAUDE.md). Les indicateurs d'état (boucle active, jauge...) viennent se
// greffer à côté de ce label aux Tasks 7/8 ; `meta`/`right` sont les points
// d'extension prévus pour eux (ex. Inbox, Task 7 : « N décisions · ~M min »).
//
// Le header et son enveloppe interne restent en display: flex (align-items:
// center / baseline) comme dans le prototype même à un seul enfant : en block
// (valeur par défaut), la boîte de ligne du span se positionne 2px plus bas
// (vérifié par getBoundingClientRect face à Dashboard.dc.html) — un pur effet
// de mode de layout, pas une valeur à recopier depuis le CSS source.
export function SectionHeader({
  label,
  meta,
  right,
}: {
  label: string
  /** Texte mono à côté du label (ex. « 7 décisions · ~20 min · plus ancienne 3 h »). */
  meta?: ReactNode
  /** Groupe droit du header (indicateurs flottants) — vide par défaut, pas de top bar. */
  right?: ReactNode
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 20,
        padding: '18px 20px 0',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <span
          style={{
            // Mono 10.5px / 0.18em, pas `--fs-label`/`--ls-label` en
            // `--font-sans` : CLAUDE.md demande des « labels de section en MONO
            // petites caps espacées (0.16-0.18em, --text-mid) », et les quatre
            // prototypes qui en portent un (Dashboard, Inbox, Clients,
            // Réglages) écrivent tous littéralement
            // `font: 600 10.5px var(--font-mono); letter-spacing: 0.18em`.
            // Les tokens `--fs-label`/`--ls-label` décrivent le gabarit
            // générique du kit, pas ce que ces pages rendent.
            font: '600 10.5px var(--font-mono)',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--text-mid)',
          }}
        >
          {label}
        </span>
        {meta && (
          <span
            style={{
              font: '11.5px var(--font-mono)',
              color: 'var(--text-low)',
              whiteSpace: 'nowrap',
            }}
          >
            {meta}
          </span>
        )}
      </div>
      {right && <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>{right}</div>}
    </header>
  )
}

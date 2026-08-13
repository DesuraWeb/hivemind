// Label de section en mono petites caps espacées (0.16-0.18em, --text-mid),
// flottant en haut du contenu sans fond ni bordure — pas de top bar
// (CLAUDE.md). Les indicateurs d'état (boucle active, jauge...) viennent se
// greffer à côté de ce label aux Tasks 7/8 ; ce composant ne porte que le
// label lui-même.
//
// Le header et son enveloppe interne restent en display: flex (align-items:
// center / baseline) comme dans le prototype même à un seul enfant : en block
// (valeur par défaut), la boîte de ligne du span se positionne 2px plus bas
// (vérifié par getBoundingClientRect face à Dashboard.dc.html) — un pur effet
// de mode de layout, pas une valeur à recopier depuis le CSS source.
export function SectionHeader({ label }: { label: string }) {
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
            font: '600 var(--fs-label) var(--font-sans)',
            letterSpacing: 'var(--ls-label)',
            textTransform: 'uppercase',
            color: 'var(--text-mid)',
          }}
        >
          {label}
        </span>
      </div>
    </header>
  )
}

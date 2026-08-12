// Label de section en mono petites caps espacées (0.16-0.18em, --text-mid),
// flottant en haut du contenu sans fond ni bordure — pas de top bar
// (CLAUDE.md). Les indicateurs d'état (boucle active, jauge...) viennent se
// greffer à côté de ce label aux Tasks 7/8 ; ce composant ne porte que le
// label lui-même.
export function SectionHeader({ label }: { label: string }) {
  return (
    <header style={{ padding: '18px 20px 0', flexShrink: 0 }}>
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
    </header>
  )
}

import type { AnalyticsView } from '../../lib/api'
import { useHover } from '../inbox/useHover'
import { Note, SectionTitle, formatEur, formatTokensShort } from './kit'

/**
 * « Par projet » : ce que chaque projet a coûté sur la fenêtre, barre
 * proportionnelle au plus gros (le serveur trie déjà du plus cher au moins
 * cher).
 *
 * La ligne sélectionne aussi le projet dont on lit le coût par step à droite —
 * le prototype fige « Le Koin », qui n'existe pas forcément ici. Chaque ligne
 * est donc un bouton, et le premier projet est sélectionné par défaut.
 *
 * Le commentaire du pack (« Calanques : 4 itérations pour 0 step validé · le
 * seul coût sans valeur du mois ») n'est pas recopié : il est **dérivé** de
 * `stepsDone`, que le serveur calcule exprès pour ce rapprochement. S'il n'y a
 * aucun projet dans ce cas, la phrase dit ça, elle ne désigne personne.
 */

export interface ProjectCostsProps {
  perProject: AnalyticsView['perProject']
  selected: string | null
  onSelect: (id: string) => void
}

function Row({
  project,
  reference,
  selected,
  onSelect,
}: {
  project: AnalyticsView['perProject'][number]
  reference: number
  selected: boolean
  onSelect: (id: string) => void
}) {
  const [hover, hoverProps] = useHover()
  const tint = project.tint ?? 'var(--pause)'
  const pct = reference > 0 ? Math.round((project.tokens / reference) * 100) : 0

  return (
    <button
      type="button"
      onClick={() => onSelect(project.id)}
      {...hoverProps}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '9px 6px',
        borderTop: 'none',
        borderLeft: 'none',
        borderRight: 'none',
        borderBottom: '1px solid var(--line)',
        background: selected
          ? 'color-mix(in oklab, var(--accent) 7%, transparent)'
          : hover
            ? 'rgba(214, 228, 247, 0.03)'
            : 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        boxSizing: 'border-box',
        transition: 'background var(--dur-1) var(--ease)',
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 8, height: 8, borderRadius: 999, background: tint, flexShrink: 0 }}
      />
      <span
        style={{
          width: 128,
          font: '500 13px var(--font-sans)',
          color: selected ? 'var(--text-hi)' : 'var(--text-mid)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {project.name}
      </span>
      <span
        style={{
          flex: 1,
          position: 'relative',
          height: 5,
          background: 'rgba(151, 173, 204, 0.10)',
          borderRadius: 999,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: `${pct}%`,
            background: `linear-gradient(90deg, color-mix(in oklab, ${tint} 55%, transparent), ${tint})`,
            borderRadius: 999,
          }}
        />
      </span>
      <span
        style={{
          width: 138,
          textAlign: 'right',
          font: '11px var(--font-mono)',
          color: 'var(--text-mid)',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        {formatEur(project.eur)} · {formatTokensShort(project.tokens)}
      </span>
    </button>
  )
}

export function ProjectCosts({ perProject, selected, onSelect }: ProjectCostsProps) {
  const reference = perProject[0]?.tokens ?? 0
  const sansValeur = perProject.filter((p) => p.tokens > 0 && p.stepsDone === 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ paddingBottom: 10 }}>
        <SectionTitle>Par projet</SectionTitle>
      </div>
      {perProject.length === 0 ? (
        <Note>
          aucun run sur la période · rien n&rsquo;a été dépensé, rien n&rsquo;a été produit
        </Note>
      ) : (
        <>
          {perProject.map((p) => (
            <Row
              key={p.id}
              project={p}
              reference={reference}
              selected={p.id === selected}
              onSelect={onSelect}
            />
          ))}
          <div style={{ paddingTop: 10 }}>
            <Note>
              {sansValeur.length > 0
                ? `${sansValeur
                    .map((p) => p.name)
                    .join(
                      ', ',
                    )} : du coût pour 0 step validé sur la période · borné par max_iterations`
                : perProject.some((p) => p.tokens > 0)
                  ? 'chaque projet ayant consommé a validé au moins un step'
                  : 'des runs sur la période, aucun token consommé · rien à comparer'}
            </Note>
          </div>
        </>
      )}
    </div>
  )
}

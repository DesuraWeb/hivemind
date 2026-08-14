import type { CSSProperties } from 'react'
import { FRAGMENT_LABEL, GLASS_ROW } from './kit'
import { MEMORY_CASCADE } from './script'

/**
 * Fragment mémoire (pack : colonne de droite en mode globe, stage 2).
 *
 * Le prototype affiche quatre cases à cocher — « Conventions Desura », « Ton
 * par défaut », « Templates de rôles », plus « Secrets & fiches clients »
 * cochée-non et verrouillée — présentées comme un arbitrage proposé par Hive.
 * `POST /api/globes` ne connaît que `name` et `color` : ces cases ne
 * commanderaient rien. Trois d'entre elles cochées d'avance feraient croire
 * qu'un héritage a été mis en place, et la quatrième, verrouillée, donnerait
 * à l'ensemble l'autorité d'un réglage réel.
 *
 * On garde donc la géométrie et le rythme d'apparition du pack, mais les
 * quatre lignes disent ce qui est vrai sans rien commander : les quatre
 * cercles de la cascade mémoire (CLAUDE.md : projet → client → globe → Hive),
 * dont la seule ligne du prototype qui disait vrai — les secrets clients ne
 * traversent jamais un globe.
 */
export function MemoryColumn({ style, revealed }: { style: CSSProperties; revealed: boolean }) {
  return (
    <div style={{ ...style, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span
        style={{
          ...FRAGMENT_LABEL,
          opacity: revealed ? 1 : 0,
          transition: 'opacity 500ms var(--ease)',
          padding: '0 2px',
        }}
      >
        Mémoire · la cascade, pas un réglage
      </span>

      {MEMORY_CASCADE.map((row, i) => (
        <div
          key={row.num}
          style={{
            ...GLASS_ROW,
            opacity: revealed ? 1 : 0,
            transform: revealed ? 'translateX(0px)' : 'translateX(18px)',
            transition: 'opacity 550ms var(--ease), transform 550ms var(--ease-out)',
            transitionDelay: `${i * 110}ms`,
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            padding: '12px 16px',
          }}
        >
          <span
            style={{
              font: '600 11px var(--font-mono)',
              color: 'var(--text-low)',
              flexShrink: 0,
            }}
          >
            {row.num}
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span
              style={{
                font: '500 13.5px var(--font-sans)',
                color: row.dim ? 'var(--text-low)' : 'var(--text-hi)',
              }}
            >
              {row.name}
            </span>
            <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
              {row.meta}
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}

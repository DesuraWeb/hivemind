import type { SavoirRevueView } from '../../lib/api'
import { Markdown } from '../Markdown'
import { PanelActions, PanelButton } from '../inbox/PanelKit'

/**
 * Une entrée de la revue de péremption (`Revue des savoirs.dc.html`, `sc-for`).
 *
 * Liseré sémantique à gauche et pas de cadre complet, comme l'Inbox et le reste
 * du pack (CLAUDE.md, axes 1-3). Les boutons sont ceux de l'Inbox
 * (`PanelKit`) : mêmes variantes, même cible tactile de 44 px au pouce — un
 * second jeu de boutons dériverait au premier ajustement.
 *
 * ## Ce qui n'est pas affiché
 *
 * Le pack met « dernier rappel : 28 juin » dans la ligne de méta et « archivée
 * = hors mémoire active, restaurable » en indice. Ni l'un ni l'autre n'existe :
 * la base compte les rappels sans les dater, et rien ne restaure un savoir
 * archivé. Les deux lignes disent donc ce qui est vrai, et rien de plus.
 */
export interface SavoirCardProps {
  savoir: SavoirRevueView
  /** Carte sous le curseur clavier : le liseré s'allume, rien d'autre ne change. */
  focused: boolean
  /** Repli en cours après une décision (`max-height` + opacité, comme `_close`). */
  vanishing: boolean
  busy: boolean
  onGarder: () => void
  onArchiver: () => void
  onFocus: () => void
  /** Ref de rappel : l'écran garde une carte par racine pour la faire défiler. */
  cardRef: (el: HTMLDivElement | null) => void
}

export function SavoirCard({
  savoir,
  focused,
  vanishing,
  busy,
  onGarder,
  onArchiver,
  onFocus,
  cardRef,
}: SavoirCardProps) {
  return (
    <div
      ref={cardRef}
      style={{
        maxHeight: vanishing ? 0 : 320,
        opacity: vanishing ? 0 : 1,
        overflow: 'hidden',
        transition: 'max-height var(--dur-3) var(--ease), opacity var(--dur-3) var(--ease)',
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: le clavier pilote la
          revue au niveau de l'écran (entrée · a · flèches), pas carte par
          carte — un gestionnaire de touches ici doublerait ce contrat. Le clic
          ne fait que déplacer le curseur, il ne décide rien. */}
      <div
        onClick={onFocus}
        style={{
          borderLeft: `2px solid color-mix(in oklab, var(--sem-verdict) ${focused ? 100 : 45}%, transparent)`,
          borderRadius: 4,
          padding: '13px 16px',
          marginBottom: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
          background: focused ? 'rgba(16, 25, 39, 0.72)' : 'rgba(13, 20, 32, 0.5)',
          transition: 'background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{savoir.sujet}</span>
          <span
            style={{
              font: '600 9.5px var(--font-mono)',
              color: 'var(--text-low)',
              border: '1px solid var(--line-strong)',
              borderRadius: 'var(--r-full)',
              padding: '1px 7px',
            }}
          >
            v{savoir.version}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              font: '10.5px var(--font-mono)',
              // Ambre : « jamais rappelée » est une information, pas une
              // absence de donnée (CLAUDE.md, score d'utilité).
              color: savoir.rappels === 0 ? 'var(--sem-question)' : 'var(--text-low)',
            }}
          >
            {savoir.pourquoi}
          </span>
        </div>

        <div style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6 }}>
          <Markdown texte={savoir.contenu} />
        </div>

        <div style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
          {savoir.cercleLabel} · archivé le{' '}
          {new Date(savoir.createdAt).toLocaleDateString('fr-FR', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </div>

        <div style={{ marginTop: 3 }}>
          <PanelActions>
            <PanelButton variant="primary" disabled={busy} onClick={onGarder}>
              Toujours vrai · garder
            </PanelButton>
            <PanelButton variant="secondary" disabled={busy} onClick={onArchiver}>
              Plus d&rsquo;actualité · archiver
            </PanelButton>
            {/* Sur la carte visée seulement : répété sur chaque entrée, cet
                indice devient du bruit qu'on cesse de lire. */}
            {focused && (
              <span
                style={{
                  alignSelf: 'center',
                  font: '10.5px var(--font-mono)',
                  color: 'var(--text-low)',
                }}
              >
                archiver la retire du rappel · ses versions restent lisibles
              </span>
            )}
          </PanelActions>
        </div>
      </div>
    </div>
  )
}

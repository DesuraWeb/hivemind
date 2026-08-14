import type { ReactNode } from 'react'

/**
 * L'état d'une étape, tel que l'écran peut le prouver.
 *
 * - `attendu` : c'est le geste du moment ;
 * - `verifie` : quelque chose a répondu, ici et maintenant ;
 * - `echec` : quelque chose a répondu, mal ;
 * - `hors-portee` : cette application ne sait ni le faire ni le mesurer. Ce
 *   n'est pas « en attente » : personne n'attend rien de cet écran-là.
 */
export type StepTone = 'attendu' | 'verifie' | 'echec' | 'hors-portee'

const NUM_COLOR: Record<StepTone, string> = {
  attendu: 'var(--accent)',
  verifie: 'var(--ok)',
  echec: 'var(--sem-alert)',
  'hors-portee': 'var(--text-low)',
}

const BORDER: Record<StepTone, string> = {
  attendu: 'color-mix(in oklab, var(--accent) 40%, transparent)',
  verifie: 'color-mix(in oklab, var(--ok) 30%, transparent)',
  echec: 'color-mix(in oklab, var(--sem-alert) 35%, transparent)',
  'hors-portee': 'var(--line)',
}

export interface StepRowProps {
  /** Pastille de gauche : le rang de l'étape, ou « ✓ » quand elle est vérifiée. */
  badge: string
  tone: StepTone
  title: string
  /** Une ligne mono sous le titre : ce que l'étape fait vraiment. */
  meta: string
  /** Colonne de droite : l'action quand il y en a une, un mot d'état sinon. */
  right: ReactNode
  /** Précisions sous la ligne (cause d'un échec, absence assumée…). */
  children?: ReactNode
}

/**
 * Une étape de l'onboarding (`Onboarding.dc.html`), avec une différence de
 * fond : le prototype fait de chaque étape un `<button>` — verrouillé et
 * grisé tant que la précédente n'est pas cochée. Ici la ligne n'est jamais un
 * bouton : elle porte son action à droite quand cette action existe, et
 * n'affiche rien de cliquable sinon. Un bouton désactivé sans explication
 * laisse croire qu'il s'activera ; ceux de cet écran ne s'activeront jamais,
 * faute de route pour les brancher.
 */
export function StepRow({ badge, tone, title, meta, right, children }: StepRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        padding: '13px 16px',
        borderRadius: 'var(--r-lg)',
        border: `1px solid ${BORDER[tone]}`,
        background:
          tone === 'attendu'
            ? 'color-mix(in oklab, var(--accent) 6%, rgba(13, 20, 32, 0.7))'
            : 'rgba(13, 20, 32, 0.55)',
        width: '100%',
        boxSizing: 'border-box',
        flexWrap: 'wrap',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 26,
          height: 26,
          flexShrink: 0,
          borderRadius: 999,
          border: `1px solid ${
            tone === 'verifie'
              ? 'transparent'
              : 'color-mix(in oklab, var(--text-low) 40%, transparent)'
          }`,
          background:
            tone === 'verifie' ? 'color-mix(in oklab, var(--ok) 20%, var(--bg-2))' : 'var(--bg-2)',
          color: NUM_COLOR[tone],
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          font: '600 11px var(--font-mono)',
        }}
      >
        {badge}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
        <span style={{ font: '500 13.5px var(--font-sans)', color: 'var(--text-hi)' }}>
          {title}
        </span>
        <span
          style={{ font: '11px var(--font-mono)', color: 'var(--text-low)', textWrap: 'pretty' }}
        >
          {meta}
        </span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{right}</span>
      {children && (
        <div
          style={{
            width: '100%',
            paddingLeft: 39,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** Une précision sous une étape : mono, discrète, jamais colorée en succès. */
export function StepNote({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span
      style={{
        font: '11px var(--font-mono)',
        color: color ?? 'var(--text-low)',
        lineHeight: 1.55,
        textWrap: 'pretty',
      }}
    >
      {children}
    </span>
  )
}

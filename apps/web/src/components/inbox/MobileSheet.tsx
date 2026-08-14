import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MobileSheetProps {
  open: boolean
  onClose: () => void
  children: ReactNode
}

/**
 * Le bottom-sheet du triage tactile (`Inbox mobile.dc.html`) : voile sombre,
 * feuille de verre qui remonte du bas, poignée, fermeture au toucher du voile.
 *
 * Monté par `createPortal` sur `body`, comme le mode ambient et pour la même
 * raison : la colonne de contenu de `Layout` est un contexte d'empilement
 * (`position: relative; z-index: 1`), un z-index posé à l'intérieur y reste
 * enfermé — la feuille serait passée sous le rail nav. Le portail la met aussi
 * au-dessus du bandeau Hive, ce qui est le but : au pouce, rien d'utile ne
 * doit finir sous le bandeau.
 *
 * La feuille reste montée en permanence, glissée hors écran (`translateY`),
 * pour que l'ouverture et la fermeture soient animées dans les deux sens.
 */
export function MobileSheet({ open, onClose, children }: MobileSheetProps) {
  return createPortal(
    <>
      <button
        type="button"
        aria-label="Fermer la fiche"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 60,
          border: 'none',
          padding: 0,
          background: 'rgba(4, 7, 12, 0.55)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity var(--dur-3) var(--ease)',
          cursor: 'default',
        }}
      />
      <div
        style={{
          position: 'fixed',
          left: 8,
          right: 8,
          bottom: 8,
          zIndex: 61,
          transform: open ? 'translateY(0)' : 'translateY(112%)',
          transition: 'transform 300ms var(--ease-out)',
          borderRadius: 24,
          background: 'var(--glass-bg)',
          WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
          backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
          border: '1px solid var(--glass-border)',
          boxShadow: 'var(--shadow-2)',
          // 82vh : la feuille ne couvre jamais tout · on doit continuer de voir
          // d'où l'on vient, et le voile au-dessus reste touchable pour fermer.
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          padding: '10px 0 max(14px, env(safe-area-inset-bottom))',
          boxSizing: 'border-box',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 36,
            height: 4,
            borderRadius: 999,
            background: 'var(--line-strong)',
            alignSelf: 'center',
            flexShrink: 0,
            marginBottom: 8,
          }}
        />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    </>,
    document.body,
  )
}

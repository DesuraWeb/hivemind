import { Outlet } from '@tanstack/react-router'
import { HiveStrip } from './HiveStrip'
import { RailNav } from './RailNav'
import '../vendor/ambiance'

// Socle commun à toutes les pages : rail nav 60px, champ d'étoiles + halo
// radial derrière tout le contenu, pas de top bar, HiveStrip flottant en bas
// centre. Reprend le gabarit des prototypes (Dashboard.dc.html, Inbox.dc.html) :
// même formule de halo, même montage de l'ambiance.
export function Layout() {
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        height: '100vh',
        overflow: 'hidden',
        background:
          'radial-gradient(1000px 600px at 60% -12%, color-mix(in oklab, var(--accent) 5%, transparent), transparent 65%), ' +
          'radial-gradient(900px 700px at -10% 110%, #0D1420, transparent 60%), ' +
          'var(--bg-0)',
        color: 'var(--text-hi)',
        fontFamily: 'var(--font-sans)',
        fontSize: 14,
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      {/* Champ d'étoiles statique (ambiance.js, opacité 3-6%) : auto-monté par
          le module vendor sur tout élément marqué data-chapo-ambiance. */}
      <div
        data-chapo-ambiance="1"
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}
      />

      <RailNav />

      <div
        style={{
          position: 'relative',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          zIndex: 1,
        }}
      >
        <Outlet />
        {/* Reprend le mécanisme exact du dc-import MajordomeStrip dans les
            prototypes (Inbox/Clients/Globes/Reglages.dc.html, etc.) : enveloppe
            en position: absolute; left: calc(50% - 240px); bottom: 12px;
            width: 480px; display: flex; justify-content: center; pointer-events:
            none — pour que les clics traversent la bande vide autour du strip,
            seul le contenu (HiveStrip, pointer-events: auto) reste cliquable. */}
        <div
          style={{
            position: 'absolute',
            left: 'calc(50% - 240px)',
            bottom: 12,
            width: 480,
            display: 'flex',
            justifyContent: 'center',
            zIndex: 30,
            pointerEvents: 'none',
          }}
        >
          <HiveStrip />
        </div>
      </div>
    </div>
  )
}

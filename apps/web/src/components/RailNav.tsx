import { Link } from '@tanstack/react-router'
import type { CSSProperties } from 'react'
import { useAuth } from '../lib/auth-context'
import '../vendor/logo-globe'

// Rail nav transparent, 60px fixes, icônes seules — ne s'étend PAS au hover
// (CLAUDE.md). Ordre imposé par le plan : Dashboard, Inbox, Globes, Clients,
// Réglages. Tracé SVG repris tel quel de MajordomeStrip.dc.html / Dashboard.dc.html
// pour rester fidèle au pack DA.

const ICON_PROPS = { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none' } as const

function DashboardIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path
        d="M3 3.5h5v5H3zM10 3.5h5v5h-5zM3 10.5h5v5H3zM10 10.5h5v5h-5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function InboxIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path
        d="M2.5 10.5L5 4.5h8l2.5 6v3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-3zM2.5 10.5h4l1 2h3l1-2h4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function GlobesIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="9" cy="9" r="2.2" fill="currentColor" opacity="0.6" />
    </svg>
  )
}

function ClientsIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <circle cx="6.8" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2.5 14.5c.5-2.4 2.2-3.8 4.3-3.8s3.8 1.4 4.3 3.8M11.6 3.9a2.4 2.4 0 0 1 0 4.3M13 10.9c1.5.5 2.4 1.7 2.7 3.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ReglagesIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path
        d="M3 5.5h7M13.6 5.5H15M3 12.5h2M8.6 12.5H15"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="11.8" cy="5.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.8" cy="12.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', Icon: DashboardIcon },
  { to: '/inbox', label: 'Inbox', Icon: InboxIcon },
  { to: '/globes', label: 'Globes', Icon: GlobesIcon },
  { to: '/clients', label: 'Clients', Icon: ClientsIcon },
  { to: '/reglages', label: 'Réglages', Icon: ReglagesIcon },
] as const

/**
 * Le `padding` n'est PAS ici : il vit dans `.rail-nav-link` (global.css), pour
 * qu'une media query puisse l'élargir sur mobile. Un style inline bat toute
 * feuille de style sans `!important` — c'est ce qui rendait les cibles
 * tactiles impossibles à corriger proprement.
 */
const itemStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  borderRadius: 'var(--r-md)',
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--text-mid)',
  cursor: 'pointer',
  font: '500 13px var(--font-sans)',
  whiteSpace: 'nowrap',
}

const activeItemStyle: CSSProperties = {
  border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)',
  background: 'var(--accent-soft)',
  color: 'var(--text-hi)',
}

export function RailNav() {
  const { me, logout } = useAuth()
  const avatarLetter = me.login.charAt(0).toUpperCase()
  return (
    <aside
      className="rail-nav"
      style={{
        width: 60,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        // Vertical seulement : la gouttière horizontale vit dans `.rail-nav`
        // (global.css), pour la même raison que le padding des liens — un
        // style inline gagnerait sur la media query mobile.
        paddingTop: 16,
        paddingBottom: 16,
        boxSizing: 'border-box',
        background: 'transparent',
        overflow: 'hidden',
        zIndex: 40,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '6px 0',
          marginBottom: 14,
        }}
      >
        <span
          data-chapo-logo="1"
          aria-hidden="true"
          style={{ width: 20, height: 20, flexShrink: 0, position: 'relative' }}
        />
      </div>
      {NAV_ITEMS.map(({ to, label, Icon }) => (
        <Link
          key={to}
          to={to}
          title={label}
          aria-label={label}
          className="rail-nav-link"
          style={itemStyle}
          // Seul « / » doit rester exact : sans ça, le Dashboard serait allumé
          // partout. Les autres entrées s'allument aussi sur leurs routes
          // filles — l'intérieur d'un globe et la fiche d'un projet vivent sous
          // /globes, et les prototypes (Projets.dc.html l. 31, Projet.dc.html
          // l. 31) y montrent bien l'icône Globes active.
          activeOptions={{ exact: to === '/' }}
          activeProps={{ style: { ...itemStyle, ...activeItemStyle } }}
        >
          <Icon />
        </Link>
      ))}
      <div
        style={{
          marginTop: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '6px 0',
        }}
      >
        <button
          type="button"
          onClick={logout}
          title="Se déconnecter"
          aria-label="Se déconnecter"
          style={{
            // 28px et non 26 : le prototype porte l'avatar sur un <span> (box-sizing
            // content-box par défaut), donc son cercle rendu fait 26px de contenu +
            // 1px de bordure de chaque côté = 28px. Notre <button> est en border-box
            // (reset global + défaut UA des form controls) : il faut donc 28px pour
            // obtenir le même cercle à l'écran (c'est le rendu qui fait foi, pas la
            // valeur littérale du style source).
            width: 28,
            height: 28,
            flexShrink: 0,
            borderRadius: 999,
            background: 'var(--bg-2)',
            border: '1px solid var(--line-strong)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            font: '600 11px var(--font-sans)',
            color: 'var(--text-mid)',
            cursor: 'pointer',
          }}
        >
          {avatarLetter}
        </button>
      </div>
    </aside>
  )
}

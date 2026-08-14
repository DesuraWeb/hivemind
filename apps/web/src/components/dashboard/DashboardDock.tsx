import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { api } from '../../lib/api'
import { BudgetPanel } from './BudgetPanel'

/**
 * Le dock droit du dashboard (`Dashboard.dc.html`, l. 189-235).
 *
 * ## Ce que le prototype met dedans, et ce qu'il en reste
 *
 * Le pack dessine deux surfaces à droite : une colonne toujours visible
 * (« Boucles » + un repli budget) et, par-dessus, un panneau de verre fixe
 * contenant un fil Hive, une liste « À faire » et **un second repli budget**.
 * Les deux se recouvrent, et le dock du pack n'a même pas de bouton pour se
 * rouvrir : `dockBtnOp` / `dockBtnPe` sont calculés dans son `renderVals()`
 * mais aucun élément ne les consomme — une fois fermé, il est perdu.
 *
 * Les trois blocs ont donc été tranchés un par un :
 *
 * **Le fil Hive n'est pas repris ici.** Il existe déjà, branché sur
 * `api.hive.messages` / `api.hive.ask`, monté par `HiveStrip` en bas de
 * TOUTES les pages (« Hive partout », `docs/design/CLAUDE.md`) — donc à
 * trois cents pixels sous ce dock, sur cet écran-là aussi. En remonter une
 * seconde instance donnerait deux fils sur la même requête, deux champs de
 * saisie, deux pastilles « en ligne » : deux Hive. Le pack a été écrit avant
 * que le bandeau ne devienne global ; le dock n'a plus à porter le fil.
 *
 * **La liste « À faire » est omise, sans rien à sa place.** Rien ne stocke de
 * tâche : ni table, ni route, ni champ. Deux façons de la remplir quand
 * même, refusées toutes les deux — inventer des lignes (le prototype en code
 * trois en dur), ou rebaptiser l'inbox « À faire ». La seconde est la plus
 * tentante et la plus trompeuse : le titre du pack désigne des intentions
 * qu'on note pour plus tard (« Brancher Matomo après le step 5 »), pas des
 * décisions qui attendent ; les afficher sous ce nom ferait croire que
 * Silithid tient un carnet de tâches qu'il ne tient pas. Ce qui attend
 * vraiment est déjà sur cet écran, compté par type, à un clic de l'inbox. Le
 * bouton « Affiner » de chaque ligne disparaît avec elle : il n'aurait rien
 * eu à affiner.
 *
 * **La jauge de budget reste**, une seule fois, dans son repli — c'est déjà
 * `BudgetPanel`, branché sur `api.budget.get()`.
 *
 * ## Ce que le dock est devenu
 *
 * La colonne du pack et son dock fusionnent : un seul panneau à droite, qui
 * porte les boucles et le budget, et qui se replie. Il **ne recouvre pas** le
 * contenu — le dashboard réduit l'orbe d'autant quand il est ouvert, et lui
 * rend la largeur quand il se ferme. C'est là son apport réel : le pack ne
 * permettait pas de rendre l'écran à l'orbe.
 *
 * Ouvert par défaut, contrairement au « dock Hive fermé au chargement » de
 * CLAUDE.md : cette préférence vise le fil de conversation, pas la liste du
 * travail en cours. Un dashboard qui s'ouvre sans ses boucles cacherait son
 * contenu principal derrière un geste.
 */

/** Largeur du dock ouvert. Le dashboard s'en sert pour dégager l'orbe. */
export const DOCK_WIDTH = 'clamp(240px, 23vw, 320px)'

/** Largeur réservée à l'onglet de réouverture quand le dock est replié. */
export const DOCK_TAB_WIDTH = 34

function ChevronLabel({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        fontSize: 10,
        color: 'var(--text-low)',
        transform: `rotate(${open ? '0deg' : '-90deg'})`,
        transition: 'transform var(--dur-2) var(--ease)',
      }}
    >
      ▾
    </span>
  )
}

/**
 * Le résumé porté par la ligne repliée du budget (« 5 h · 62 % · réserve
 * intacte » dans le pack). Sans lui, replier le budget revient à ne plus rien
 * savoir, ce qui est le contraire du geste attendu.
 *
 * Même clé de requête que `BudgetPanel` : react-query dédoublonne, ouvrir le
 * repli ne déclenche aucun second appel. Et surtout, mêmes distinctions —
 * jamais un pourcentage quand la jauge est absente, jamais un zéro rassurant.
 */
function BudgetSummary() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['budget'],
    queryFn: api.budget.get,
    refetchInterval: 60_000,
  })

  let text: string
  if (isPending) text = 'mesure en cours…'
  else if (isError) text = 'jauge injoignable'
  else if (!data.gauge) text = 'jauge inconnue'
  else {
    const reserve = data.reserve.state === 'entamee' ? 'entamée' : 'intacte'
    text = `5 h · ${data.gauge.fiveHourPct} % · réserve ${reserve}`
  }

  return (
    <span
      style={{
        marginLeft: 'auto',
        font: '10.5px var(--font-mono)',
        color: 'var(--text-mid)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  )
}

export interface DashboardDockProps {
  open: boolean
  onToggle: () => void
  /** Le contenu haut du dock : la liste des boucles, rendue par le dashboard. */
  children: ReactNode
}

export function DashboardDock({ open, onToggle, children }: DashboardDockProps) {
  const [budgetOpen, setBudgetOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Afficher les boucles et le budget"
        aria-expanded={false}
        style={{
          position: 'absolute',
          right: 20,
          top: 12,
          width: DOCK_TAB_WIDTH,
          padding: '10px 0',
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          borderRadius: 'var(--r-md)',
          border: '1px solid var(--line)',
          background: 'transparent',
          color: 'var(--text-mid)',
          cursor: 'pointer',
          transition: 'all var(--dur-1) var(--ease)',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 11, lineHeight: 1 }}>
          ‹
        </span>
        <span
          style={{
            font: '600 10px var(--font-mono)',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            writingMode: 'vertical-rl',
          }}
        >
          Boucles
        </span>
      </button>
    )
  }

  return (
    <div
      style={{
        position: 'absolute',
        right: 20,
        top: 12,
        bottom: 20,
        width: DOCK_WIDTH,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      <div style={{ padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 2px 8px',
          }}
        >
          <span
            style={{
              font: '600 10.5px var(--font-mono)',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--text-mid)',
            }}
          >
            Boucles · le travail en cours
          </span>
          <button
            type="button"
            onClick={onToggle}
            title="Replier · rendre la largeur à l’orbe"
            aria-expanded
            style={{
              marginLeft: 'auto',
              width: 22,
              height: 22,
              flexShrink: 0,
              borderRadius: 'var(--r-sm)',
              border: 'none',
              background: 'transparent',
              color: 'var(--text-mid)',
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>

      <div style={{ padding: '10px 2px 4px', marginTop: 'auto' }}>
        <button
          type="button"
          onClick={() => setBudgetOpen((v) => !v)}
          aria-expanded={budgetOpen}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 2,
          }}
        >
          <span
            style={{
              font: '600 10.5px var(--font-mono)',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--text-mid)',
            }}
          >
            Budget
          </span>
          <BudgetSummary />
          <ChevronLabel open={budgetOpen} />
        </button>
        {budgetOpen && <BudgetPanel />}
      </div>
    </div>
  )
}

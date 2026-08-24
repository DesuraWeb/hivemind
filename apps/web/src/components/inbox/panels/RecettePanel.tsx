import { useState } from 'react'
import { CtxLine, PanelActions, PanelButton, SectionLabel } from '../PanelKit'
import type { PanelProps } from './types'

/**
 * Panneau « approval · recette » : ajouter une étape à la recette d'une stack.
 *
 * C'est le seul endroit de tout le système où ce qui s'exécute AUTOMATIQUEMENT
 * s'élargit. Une étape de recette part d'office, sans validation, sur chaque
 * prochain serveur vierge de cette stack — pas seulement sur celui qui a
 * motivé la proposition.
 *
 * Le panneau le dit en toutes lettres et montre la commande, parce
 * qu'approuver sans voir ce que ça exécutera reviendrait à signer un chèque en
 * blanc pour tous les déploiements à venir de cette stack.
 *
 * Le champ de correction reprend la règle des savoirs : la formulation de
 * Florian remplace celle de l'agent, et c'est elle qu'on relira dans six mois.
 */
export function RecettePanel({ item, resolving, onResolve }: PanelProps) {
  const etape = item.payload.etape as
    | { stack?: string; nom?: string; pourquoi?: string }
    | undefined
  const commande = typeof item.payload.commande === 'string' ? item.payload.commande : null
  const ctx = typeof item.payload.ctx === 'string' ? item.payload.ctx : null
  const [texte, setTexte] = useState('')

  return (
    <>
      {/* La portée d'abord : c'est elle qui change tout par rapport à un plan
          ordinaire, qui ne vaut que pour un serveur. */}
      <div
        style={{
          border: '1px solid color-mix(in oklab, var(--sem-approval) 30%, transparent)',
          borderLeft: '3px solid var(--sem-approval)',
          borderRadius: 'var(--r-md)',
          background: 'color-mix(in oklab, var(--sem-approval) 6%, transparent)',
          padding: '11px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
        }}
      >
        <span
          style={{
            font: '600 10px var(--font-sans)',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--sem-approval)',
          }}
        >
          Portée · toute la stack {etape?.stack ?? ''}
        </span>
        <span style={{ fontSize: 13, color: 'var(--text-hi)', lineHeight: 1.55 }}>
          {ctx ?? 'Cette opération s’exécutera d’office sur les prochains serveurs vierges.'}
        </span>
      </div>

      <CtxLine>{etape?.pourquoi ?? item.title}</CtxLine>

      {commande && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionLabel>{etape?.nom} · ce qui s’exécutera</SectionLabel>
          <pre
            style={{
              margin: 0,
              padding: '8px 10px',
              borderRadius: 'var(--r-sm, 6px)',
              background: 'var(--bg-0)',
              font: '11px var(--font-mono)',
              color: 'var(--text-mid)',
              overflowX: 'auto',
              whiteSpace: 'pre',
              lineHeight: 1.6,
            }}
          >
            {commande}
          </pre>
          <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
            paramètres d&rsquo;exemple · l&rsquo;agent les complète pour chaque projet
          </span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SectionLabel>Votre formulation, si celle de l&rsquo;agent ne va pas</SectionLabel>
        <textarea
          value={texte}
          onChange={(e) => setTexte(e.target.value)}
          placeholder="pourquoi toute la stack en a besoin · c’est ce qu’on relira dans six mois"
          rows={2}
          style={{
            width: '100%',
            resize: 'vertical',
            padding: '8px 10px',
            borderRadius: 'var(--r-md)',
            border: '1px solid var(--line)',
            background: 'var(--bg-0)',
            color: 'var(--text-hi)',
            font: '12.5px var(--font-sans)',
            lineHeight: 1.6,
          }}
        />
        <PanelActions>
          <PanelButton
            variant="primary"
            disabled={resolving}
            onClick={() =>
              onResolve({ approved: true, ...(texte.trim() ? { text: texte.trim() } : {}) })
            }
          >
            Ajouter à la recette
          </PanelButton>
          <PanelButton
            variant="secondary"
            disabled={resolving}
            onClick={() => onResolve({ approved: false })}
          >
            Refuser
          </PanelButton>
        </PanelActions>
        <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
          refuser ne bloque rien · l&rsquo;agent pourra continuer à la proposer au cas par cas dans
          un plan
        </span>
      </div>
    </>
  )
}

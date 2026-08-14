import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { JournalNightEntry } from '../../lib/api'
import { formatTime, roleColor, roleLabel } from './journal'
import { FootNote, Rail, RailRow, RowMeta, RowText } from './kit'

/**
 * Onglet « Nuit des agents » : les passations du bus (`messages`) sur la
 * fenêtre demandée, du plus récent au plus ancien.
 *
 * ## Deux champs du prototype qui ne sont pas ici
 *
 * **Le coût par ligne** (« 5 872 tok · 1,04 € ») : rien ne mesure le coût
 * d'une passation. `runs.cost_tokens` est un cumul sur tout le run, itérations
 * comprises (cf. `apps/server/src/analytics/repo.ts`). Afficher « 0 tok » sur
 * chaque ligne ferait croire à une mesure gratuite ; afficher le coût du run
 * sur chacune de ses passations le compterait dix fois. La colonne de droite
 * porte donc la nature du message (`prompt`, `report`, `question`…), qui
 * existe, et le pied de l'onglet dit où le coût se lit vraiment.
 *
 * **La phrase de synthèse** en tête (« Pendant votre sommeil : Le Koin a
 * avancé d'une itération… ») : c'est une rédaction de Hive dans le pack.
 * Aucune route ne la produit — `POST /api/hive/messages` coûterait un vrai
 * échange modèle à chaque ouverture du journal. Elle est absente plutôt que
 * fabriquée côté front à partir des lignes qu'on affiche déjà en dessous.
 */

/** Un corps de message peut faire plusieurs milliers de caractères : replié par défaut, dépliable. */
const CLAMP_AT = 320

function Body({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > CLAMP_AT

  return (
    <>
      <RowText>
        <span
          style={
            long && !open
              ? {
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  whiteSpace: 'pre-wrap',
                }
              : { whiteSpace: 'pre-wrap' }
          }
        >
          {text}
        </span>
      </RowText>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            alignSelf: 'flex-start',
            padding: 0,
            border: 'none',
            background: 'transparent',
            font: '11px var(--font-mono)',
            color: 'var(--accent)',
            cursor: 'pointer',
          }}
        >
          {open ? 'replier' : `déplier · ${text.length} caractères`}
        </button>
      )}
    </>
  )
}

export interface NightTimelineProps {
  entries: JournalNightEntry[]
  retentionDays: number
}

export function NightTimeline({ entries, retentionDays }: NightTimelineProps) {
  if (entries.length === 0) {
    return (
      <FootNote>
        aucune passation sur cette fenêtre · les nuits sans activité ne génèrent pas d&rsquo;entrée
      </FootNote>
    )
  }

  return (
    <>
      <Rail>
        {entries.map((e) => (
          <RailRow key={e.id} time={formatTime(e.at)} dot={roleColor(e.role)}>
            <RowMeta>
              <span style={{ font: '600 12px var(--font-sans)', color: roleColor(e.role) }}>
                {roleLabel(e.role)}
              </span>
              <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
                → {roleLabel(e.toRole)}
              </span>
              {e.projectName && (
                <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
                  {e.projectName}
                </span>
              )}
              <span
                style={{
                  marginLeft: 'auto',
                  font: '10.5px var(--font-mono)',
                  color: 'var(--text-low)',
                  whiteSpace: 'nowrap',
                }}
              >
                {e.kind}
              </span>
            </RowMeta>
            <Body text={e.text} />
            <Link
              to="/runs/$runId"
              params={{ runId: e.runId }}
              style={{
                font: '11px var(--font-mono)',
                alignSelf: 'flex-start',
                color: 'var(--accent)',
                textDecoration: 'none',
              }}
            >
              voir le run →
            </Link>
          </RailRow>
        ))}
      </Rail>
      <FootNote>
        journal conservé {retentionDays} j · le coût n&rsquo;est pas mesuré par passation, il est
        cumulé par run et se lit dans Analytics
      </FootNote>
    </>
  )
}

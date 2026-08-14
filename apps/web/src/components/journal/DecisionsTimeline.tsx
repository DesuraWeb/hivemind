import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import type { JournalDecisionEntry } from '../../lib/api'
import {
  dayKey,
  dayLabel,
  decisionColor,
  decisionTag,
  describeResponse,
  formatTime,
} from './journal'
import { FootNote, Rail, RailRow, RowMeta, RowText } from './kit'

/**
 * Onglet « Vos décisions » : les items d'inbox réellement tranchés
 * (`inbox_items` avec `resolved_at`), groupés par journée.
 *
 * ## La révocation n'est pas ici, et ce n'est pas un oubli
 *
 * Le prototype offre « Révoquer », « Repasser en gates », « Revenir à 4 », un
 * badge RÉVOQUÉE et une ligne barrée. Rien de tout ça n'est rendu ici : le
 * serveur écrit `revocable: false` sur **chaque** décision, toujours
 * (`apps/server/src/journal/repo.ts`).
 *
 * Défaire une décision est un geste différent pour chacune — remettre des
 * gates sur des steps, redescendre un `max_iterations`, rappeler un email déjà
 * parti (impossible). Il n'existe pas de « révocation » générique à câbler.
 * Le bouton est donc **absent**, pas désactivé : un bouton grisé sans
 * destinataire laisserait croire qu'il suffit d'attendre, alors que ce qui
 * manque est une décision produit par type de décision. L'onglet le dit une
 * fois en pied de page plutôt que vingt fois par ligne.
 *
 * Le champ « lien » du pack (« voir le run », « voir l'email ») devient un
 * seul lien vers le projet concerné : c'est la seule destination que la ligne
 * porte réellement (`projectId` est le slug du projet). Une décision sans
 * projet (question globale) n'a pas de lien du tout.
 */

export interface DecisionsTimelineProps {
  decisions: JournalDecisionEntry[]
  retentionDays: number
  /** Slug du globe d'un projet, pour construire `/globes/:globe/:projet`. `null` si inconnu. */
  globeOf: (projectSlug: string) => string | null
}

interface DayGroup {
  key: string
  label: string
  items: JournalDecisionEntry[]
}

function groupByDay(decisions: JournalDecisionEntry[]): DayGroup[] {
  const groups: DayGroup[] = []
  for (const d of decisions) {
    const key = dayKey(d.at)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.items.push(d)
    else groups.push({ key, label: dayLabel(d.at), items: [d] })
  }
  return groups
}

export function DecisionsTimeline({ decisions, retentionDays, globeOf }: DecisionsTimelineProps) {
  const groups = useMemo(() => groupByDay(decisions), [decisions])

  if (decisions.length === 0) {
    return (
      <FootNote>
        aucune décision tranchée sur cette fenêtre · un item encore ouvert n&rsquo;en est pas une,
        il attend dans l&rsquo;inbox
      </FootNote>
    )
  }

  return (
    <>
      {groups.map((g) => (
        <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div
            style={{
              font: '600 10px var(--font-mono)',
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--text-low)',
              padding: '0 0 8px 92px',
            }}
          >
            {g.label}
          </div>
          <Rail gap={18}>
            {g.items.map((d) => {
              const color = decisionColor(d.kind)
              const answer = describeResponse(d.response)
              const globe = d.projectId ? globeOf(d.projectId) : null
              return (
                <RailRow key={d.id} time={formatTime(d.at)} dot={color}>
                  <RowMeta>
                    <span
                      style={{
                        font: '600 10px var(--font-mono)',
                        letterSpacing: '0.12em',
                        color,
                      }}
                    >
                      {decisionTag(d.kind, d.subtype)}
                    </span>
                    <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
                      {d.projectName ?? 'sans projet'}
                    </span>
                  </RowMeta>
                  <RowText>{d.title}</RowText>
                  {answer && (
                    <div
                      style={{
                        font: '11.5px var(--font-mono)',
                        color: 'var(--text-mid)',
                        lineHeight: 1.6,
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      votre réponse · {answer}
                    </div>
                  )}
                  {d.projectId && globe && (
                    <Link
                      to="/globes/$globeId/$projectId"
                      params={{ globeId: globe, projectId: d.projectId }}
                      style={{
                        font: '11px var(--font-mono)',
                        alignSelf: 'flex-start',
                        color: 'var(--accent)',
                        textDecoration: 'none',
                      }}
                    >
                      voir le projet →
                    </Link>
                  )}
                </RailRow>
              )
            })}
          </Rail>
        </div>
      ))}
      <FootNote>
        conservé {retentionDays} j · lecture seule : rien ne se révoque depuis le journal · défaire
        une décision est un geste différent pour chacune (remettre des gates, redescendre
        max_iterations, rappeler un email déjà parti), aucun n&rsquo;est écrit
      </FootNote>
    </>
  )
}

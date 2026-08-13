import { useState } from 'react'
import { ApiError, api } from '../../../lib/api'
import type { OptimizeAnswerResult } from '../../../lib/inbox-types'
import { PanelActions, PanelButton, SectionLabel, textareaStyle } from '../PanelKit'
import type { PanelProps } from './types'

// Panneau « question » (Inbox.dc.html, sc-if selQ). Le prototype affiche un
// texte « pourquoi cette question » distinct du titre (fixture DETAILS,
// éditorial) : notre backend n'a pas encore ce niveau de détail à ce stade
// (la question elle-même vit dans le bus `messages`, pas encore exposé par
// une route — le fil de conversation Hive est Task 8). Le titre de l'item
// EST donc la question ; on ne fabrique pas de texte supplémentaire.
//
// `DetailPanel` monte ce composant avec `key={item.id}` : changer d'item
// démonte/remonte plutôt que de réutiliser l'instance, donc tout l'état local
// ci-dessous (réponse tapée, proposition Hive) repart à zéro sans effet
// dédié — une proposition d'une question précédente ne doit jamais rester
// affichée comme si elle portait sur la question courante.
export function QuestionPanel({ item, projectName, resolving, onResolve, onClose }: PanelProps) {
  const [text, setText] = useState('')
  const [optimizing, setOptimizing] = useState(false)
  const [optimizeError, setOptimizeError] = useState<string | null>(null)
  const [proposal, setProposal] = useState<OptimizeAnswerResult | null>(null)
  const [proposalIgnored, setProposalIgnored] = useState(false)
  // Capturée au moment de l'appel, distincte de `text` : cliquer « Utiliser »
  // écrase `text` avec la proposition, et sans cette copie séparée la réponse
  // brute de Florian disparaîtrait de l'écran — alors que les trois états
  // (brute, proposition, ce qui part réellement) doivent rester visibles.
  const [rawDraft, setRawDraft] = useState('')

  async function handleOptimize() {
    const draft = text.trim()
    setOptimizing(true)
    setOptimizeError(null)
    try {
      const result = await api.inbox.optimize(item.id, draft)
      setProposal(result)
      setProposalIgnored(false)
      setRawDraft(draft)
    } catch (err) {
      setOptimizeError(err instanceof ApiError ? err.message : "l'optimisation a échoué, réessayez")
    } finally {
      setOptimizing(false)
    }
  }

  return (
    <>
      <div
        style={{
          borderLeft: '2px solid color-mix(in oklab, var(--sem-question) 45%, transparent)',
          padding: '2px 0 2px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <SectionLabel>Pourquoi cette question</SectionLabel>
        <span style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6 }}>
          {item.title}
        </span>
        <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
          {projectName} · posée par {item.agent ?? '·'}
        </span>
      </div>

      <textarea
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Votre réponse à l'agent…"
        style={textareaStyle}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <PanelButton
          variant="secondary"
          disabled={optimizing || text.trim().length === 0}
          onClick={() => void handleOptimize()}
        >
          {optimizing ? 'Optimisation…' : 'Optimiser'}
        </PanelButton>
        {optimizing && (
          <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
            quelques secondes, c'est un vrai échange modèle
          </span>
        )}
        {optimizeError && !optimizing && (
          <span style={{ font: '11px var(--font-mono)', color: 'var(--sem-alert)' }}>
            {optimizeError}
          </span>
        )}
      </div>

      {proposal && (
        <div
          style={{
            borderLeft: '2px solid color-mix(in oklab, var(--accent) 45%, transparent)',
            padding: '2px 0 2px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <SectionLabel>Réponse brute soumise à Hive</SectionLabel>
          <span
            style={{
              font: '12.5px var(--font-mono)',
              color: 'var(--text-low)',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
            }}
          >
            {rawDraft}
          </span>

          <SectionLabel>Proposition Hive</SectionLabel>
          <span
            style={{
              fontSize: 13,
              color: 'var(--text-mid)',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
            }}
          >
            {proposal.optimized}
          </span>

          {proposal.added.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <SectionLabel>Ajouté par Hive</SectionLabel>
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                {proposal.added.map((added) => (
                  <li
                    key={added}
                    style={{ font: '12px var(--font-mono)', color: 'var(--text-low)' }}
                  >
                    {added}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {proposalIgnored ? (
            <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
              ignorée, toujours consultable ci-dessus
            </span>
          ) : (
            <PanelActions>
              <PanelButton variant="secondary" onClick={() => setText(proposal.optimized)}>
                Utiliser
              </PanelButton>
              <PanelButton variant="ghost" onClick={() => setProposalIgnored(true)}>
                Ignorer
              </PanelButton>
            </PanelActions>
          )}
        </div>
      )}

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--text-mid)',
        }}
      >
        <input
          type="checkbox"
          checked={item.archiveToClient}
          disabled
          readOnly
          style={{ accentColor: 'var(--accent)', width: 15, height: 15, margin: 0 }}
        />
        <span>
          Archiver la réponse dans la fiche client
          {/* Réglage figé à la création de l'item (resolve.ts) : la résolution ne
              peut pas le changer dans cette phase, la case reflète l'état réel
              plutôt que de simuler un contrôle qui ne fait rien. */}
          <span style={{ color: 'var(--text-low)', fontWeight: 400 }}>
            {' '}
            · décidé à la création de l'item
          </span>
        </span>
      </label>

      <PanelActions>
        <PanelButton
          variant="primary"
          disabled={resolving || text.trim().length === 0}
          onClick={() => onResolve({ text: text.trim() })}
        >
          Envoyer la réponse
        </PanelButton>
        <PanelButton variant="ghost" onClick={onClose}>
          Reporter
        </PanelButton>
      </PanelActions>
    </>
  )
}

import { useState } from 'react'
import { PanelActions, PanelButton, SectionLabel, textareaStyle } from '../PanelKit'
import type { PanelProps } from './types'

// Panneau « question » (Inbox.dc.html, sc-if selQ). Le prototype affiche un
// texte « pourquoi cette question » distinct du titre (fixture DETAILS,
// éditorial) : notre backend n'a pas encore ce niveau de détail à ce stade
// (la question elle-même vit dans le bus `messages`, pas encore exposé par
// une route — le fil de conversation Hive est Task 8). Le titre de l'item
// EST donc la question ; on ne fabrique pas de texte supplémentaire.
export function QuestionPanel({ item, projectName, resolving, onResolve, onClose }: PanelProps) {
  const [text, setText] = useState('')

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
          {projectName} · posée par {item.agent ?? '—'}
        </span>
      </div>

      <textarea
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Votre réponse à l'agent…"
        style={textareaStyle}
      />

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

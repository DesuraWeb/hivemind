import { useEffect, useRef, useState } from 'react'
import type { CreateGlobeInput } from '../../lib/api'

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box' as const,
  background: 'rgba(9, 14, 22, 0.65)',
  border: '1px solid var(--line-strong)',
  borderRadius: 'var(--r-md)',
  padding: '9px 12px',
  font: '500 13px var(--font-sans)',
  color: 'var(--text-hi)',
  outline: 'none',
}

/**
 * CRUD minimal (plan Phase 3, Task 8 : « formulaire simple ; la création
 * conversationnelle via Hive [Creation.dc.html] est une clause de
 * débordement explicite du plan », pas construite ici).
 */
export function CreateGlobeForm({
  onCancel,
  onSubmit,
  submitting,
  error,
}: {
  onCancel: () => void
  onSubmit: (input: CreateGlobeInput) => void
  submitting: boolean
  error?: string
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#7FB8E8')
  const nameRef = useRef<HTMLInputElement>(null)
  // `autoFocus` est banni par le linter (a11y/noAutofocus) : ce panneau n'apparaît
  // qu'après un geste explicite (clic sur « + Nouveau globe »), donc le focus
  // programmatique au montage reste attendu par qui vient de cliquer.
  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  return (
    <div
      style={{
        position: 'absolute',
        right: 24,
        top: 56,
        zIndex: 25,
        width: 280,
        borderRadius: 'var(--r-lg)',
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
        WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
        border: '1px solid var(--glass-border)',
        boxShadow: 'var(--shadow-2)',
        padding: 16,
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const trimmed = name.trim()
          if (trimmed) onSubmit({ name: trimmed, color })
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <span
          style={{
            font: '600 10px var(--font-mono)',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--text-mid)',
          }}
        >
          Nouveau globe
        </span>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nom du globe"
          aria-label="Nom du globe"
          style={inputStyle}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>Teinte</span>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            style={{
              width: 32,
              height: 24,
              padding: 0,
              border: '1px solid var(--line)',
              borderRadius: 6,
              background: 'transparent',
            }}
          />
        </label>
        {error && (
          <span style={{ font: '11px var(--font-mono)', color: 'var(--sem-alert)' }}>{error}</span>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 2 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '7px 14px',
              borderRadius: 'var(--r-full)',
              border: '1px solid var(--line-strong)',
              background: 'transparent',
              color: 'var(--text-mid)',
              font: '500 12px var(--font-sans)',
              cursor: 'pointer',
            }}
          >
            Annuler
          </button>
          <button
            type="submit"
            disabled={!name.trim() || submitting}
            style={{
              padding: '7px 14px',
              borderRadius: 'var(--r-full)',
              border: '1px solid transparent',
              background: 'var(--accent)',
              color: 'var(--accent-ink)',
              font: '500 12px var(--font-sans)',
              cursor: submitting ? 'default' : 'pointer',
              opacity: !name.trim() || submitting ? 0.6 : 1,
            }}
          >
            {submitting ? 'Création…' : 'Créer'}
          </button>
        </div>
      </form>
    </div>
  )
}

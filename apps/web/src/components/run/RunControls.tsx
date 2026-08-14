import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { InstructableRole } from './instruct'
import { INSTRUCTABLE_ROLES } from './instruct'
import type { PipelineRole, RunPhase } from './state'
import { roleLabel } from './state'

export interface RunControlsProps {
  phase: RunPhase
  /** État brut du run : sert à distinguer les deux pauses, que `phase` confond. */
  state: string
  activeRole: PipelineRole | null
  pausing: boolean
  resuming: boolean
  stopping: boolean
  instructing: boolean
  /** Erreur de la dernière commande (409 de la machine à états, réseau…). */
  error: string | null
  /**
   * Ce que le serveur a répondu à la dernière consigne : son `readAt`, affiché
   * mot pour mot. C'est lui qui dit quand elle sera lue, pas nous.
   */
  posted: { role: string; readAt: string } | null
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onInstruct: (role: InstructableRole, text: string, pauseFirst: boolean) => void
  onDismissPosted: () => void
}

const BTN: CSSProperties = {
  padding: '10px 18px',
  borderRadius: 'var(--r-full)',
  border: '1px solid var(--line-strong)',
  background: 'rgba(9, 14, 22, 0.75)',
  color: 'var(--text-hi)',
  font: '500 13px var(--font-sans)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/**
 * Reprendre la main sur une boucle : pause, arrêt, consigne.
 *
 * ## Le point d'honnêteté
 *
 * Une consigne injectée n'est PAS lue par la session en cours. Les handlers
 * lisent le bus une seule fois, au démarrage de leur invocation
 * (`loop/instructions.ts`) : ce qu'on écrit pendant que le dev travaille sera
 * lu au tour suivant, pas maintenant. Le pack laisse croire l'inverse — champ
 * de chat, micro « j'écoute », message « prise en compte à la prochaine action
 * du dev » glissé après coup.
 *
 * Trois décisions en découlent :
 *
 * 1. **Le geste par défaut est la séquence complète.** Quand la boucle avance,
 *    le bouton d'envoi ne dit pas « Envoyer » mais « Mettre en pause et poser
 *    la consigne » — et c'est ce qu'il fait, dans cet ordre. La reprise reste
 *    un clic explicite : on ne relance pas une boucle à la place de quelqu'un
 *    qui vient de l'arrêter pour regarder.
 * 2. **Le champ ne ressemble pas à une conversation.** Pas de bulle, pas de
 *    micro (aucune dictée n'existe : un micro qui ne transcrit rien serait le
 *    mensonge le plus coûteux de l'écran), et un libellé qui nomme le
 *    destinataire et le moment de lecture.
 * 3. **La confirmation reprend les mots du serveur.** Après l'envoi, la
 *    réponse affiche `readAt` tel que la route le rend — « prochaine
 *    invocation du handler de ce rôle » — plutôt qu'une formule à nous.
 */
export function RunControls(props: RunControlsProps) {
  const { phase, state, activeRole, pausing, resuming, stopping, instructing, error, posted } =
    props

  const [confirmStop, setConfirmStop] = useState(false)
  const [note, setNote] = useState('')
  const [role, setRole] = useState<InstructableRole>(activeRole === 'garant' ? 'garant' : 'dev')
  const confirmTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
    }
  }, [])

  const ended = phase === 'ended'
  const canPause = phase === 'advancing'
  const canResume = state === 'paused_human'
  const busy = pausing || resuming || stopping || instructing

  function askStop() {
    if (ended) return
    if (!confirmStop) {
      setConfirmStop(true)
      confirmTimer.current = window.setTimeout(() => setConfirmStop(false), 3200)
      return
    }
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
    setConfirmStop(false)
    props.onStop()
  }

  function submit() {
    const text = note.trim()
    if (!text || ended || instructing) return
    props.onInstruct(role, text, canPause)
    setNote('')
  }

  // Ce que la boucle attend, dit en clair à côté des boutons : sur
  // `awaiting_human` la pause est refusée par la machine à états, sur
  // `paused_budget` la reprise appartient au scheduler de budget.
  const hint =
    phase === 'waiting'
      ? 'la boucle attend une réponse dans l’inbox · ni pause ni reprise ici'
      : state === 'paused_budget'
        ? 'pause budgétaire · la reprise est automatique quand la jauge redescend'
        : state === 'paused_human'
          ? 'en pause à votre demande · rien n’avance tant que vous ne reprenez pas'
          : null

  return (
    <footer
      style={{
        position: 'relative',
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 26px 118px',
        maxWidth: 900,
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
        flexShrink: 0,
      }}
    >
      {posted && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            borderLeft: '3px solid var(--ok)',
            background: 'color-mix(in oklab, var(--ok) 6%, transparent)',
            borderRadius: 4,
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            Consigne posée pour le {roleLabel(posted.role)} · lue à la {posted.readAt}.
            {canResume ? ' Reprenez la boucle pour qu’elle soit lue.' : ''}
          </span>
          {canResume && (
            <button
              type="button"
              onClick={props.onResume}
              disabled={busy}
              style={{ ...BTN, padding: '7px 14px', font: '500 12.5px var(--font-sans)' }}
            >
              {resuming ? 'reprise…' : 'Reprendre'}
            </button>
          )}
          <button
            type="button"
            onClick={props.onDismissPosted}
            aria-label="Masquer la confirmation"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--text-low)',
              cursor: 'pointer',
              font: '13px var(--font-mono)',
            }}
          >
            ×
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            padding: '10px 14px',
            borderLeft: '3px solid var(--sem-alert)',
            background: 'color-mix(in oklab, var(--sem-alert) 6%, transparent)',
            borderRadius: 4,
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={canResume ? props.onResume : props.onPause}
          disabled={busy || (!canPause && !canResume)}
          title={
            canResume
              ? 'Relance la boucle à l’étape exacte où elle s’était arrêtée'
              : 'La pause prend effet à la fin de l’action en cours'
          }
          style={{
            ...BTN,
            opacity: !canPause && !canResume ? 0.4 : 1,
            cursor: busy || (!canPause && !canResume) ? 'default' : 'pointer',
          }}
        >
          {canResume
            ? resuming
              ? 'reprise…'
              : 'Reprendre'
            : pausing
              ? 'pause…'
              : 'Mettre en pause'}
        </button>

        <button
          type="button"
          onClick={askStop}
          disabled={ended || stopping}
          style={{
            ...BTN,
            border: '1px solid color-mix(in oklab, var(--sem-alert) 40%, transparent)',
            background: 'transparent',
            color: 'var(--sem-alert)',
            padding: '10px 16px',
            opacity: ended ? 0.4 : 1,
            cursor: ended || stopping ? 'default' : 'pointer',
          }}
        >
          {ended
            ? 'Boucle terminée'
            : stopping
              ? 'arrêt…'
              : confirmStop
                ? 'Confirmer l’arrêt ?'
                : 'Stopper'}
        </button>

        {hint && (
          <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>{hint}</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            font: '600 10px var(--font-mono)',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--text-low)',
          }}
        >
          Consigne pour
        </span>
        {INSTRUCTABLE_ROLES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRole(r)}
            disabled={ended}
            style={{
              padding: '5px 13px',
              borderRadius: 'var(--r-full)',
              border: `1px solid ${
                role === r ? 'color-mix(in oklab, var(--accent) 50%, transparent)' : 'var(--line)'
              }`,
              background:
                role === r ? 'color-mix(in oklab, var(--accent) 12%, transparent)' : 'transparent',
              color: role === r ? 'var(--text-hi)' : 'var(--text-mid)',
              font: '500 12px var(--font-sans)',
              cursor: ended ? 'default' : 'pointer',
              opacity: ended ? 0.5 : 1,
            }}
          >
            {roleLabel(r)}
          </button>
        ))}
        <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
          eux seuls relisent le bus · une consigne au reviewer ou au juge ne serait jamais lue
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          type="text"
          disabled={ended}
          aria-label={`Consigne pour le ${roleLabel(role)}`}
          placeholder={
            ended
              ? 'boucle terminée · aucune consigne ne sera plus lue'
              : `Consigne pour le prochain tour du ${roleLabel(role)}…`
          }
          style={{
            flex: 1,
            minWidth: 0,
            background: 'rgba(9, 14, 22, 0.75)',
            border: '1px solid var(--line-strong)',
            borderRadius: 'var(--r-full)',
            padding: '11px 18px',
            font: '500 13px var(--font-sans)',
            color: 'var(--text-hi)',
            outline: 'none',
            opacity: ended ? 0.5 : 1,
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={ended || instructing || note.trim().length === 0}
          style={{
            ...BTN,
            border: '1px solid color-mix(in oklab, var(--accent) 50%, transparent)',
            opacity: ended || note.trim().length === 0 ? 0.4 : 1,
            cursor: ended || instructing || note.trim().length === 0 ? 'default' : 'pointer',
          }}
        >
          {instructing
            ? 'envoi…'
            : canPause
              ? 'Mettre en pause et poser la consigne'
              : 'Poser la consigne'}
        </button>
      </div>

      <span
        style={{
          font: '10.5px var(--font-mono)',
          color: 'var(--text-low)',
          lineHeight: 1.6,
        }}
      >
        Une consigne n’est pas lue par la session en cours · chaque handler lit le bus au démarrage
        de son invocation. Le geste qui marche : pause · consigne · reprise.
      </span>
    </footer>
  )
}

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect } from 'react'
import { api } from '../lib/api'
import { subscribeToEvents } from '../lib/events'

/**
 * Le bandeau d'alerte, présent sur tous les écrans.
 *
 * ## Le défaut qu'il corrige
 *
 * L'application a levé une alerte « authentification agent indisponible » à
 * 23:45. Florian l'a découverte le lendemain matin, parce que quelqu'un est
 * allé lire la base. Pendant toute la nuit, l'app SAVAIT, et aucun écran ne le
 * disait : le diagnostic d'authentification est un geste, enfoui dans
 * Réglages, qui ne s'exécute que si on clique dessus.
 *
 * Ce dépôt s'astreint à « ne jamais afficher un état qu'on n'a pas ». Il lui
 * manquait le pendant, et c'est celui-ci : **ne jamais rester muet sur une
 * panne qu'on connaît déjà.**
 *
 * ## Il n'invente aucun état
 *
 * Il ne sonde rien, ne mesure rien, ne déduit rien. Il lit les items d'inbox
 * de type `alert` encore ouverts · c'est-à-dire exactement ce que le serveur a
 * lui-même décidé de signaler. Un écran qui afficherait « tout va bien » en
 * l'absence d'alerte affirmerait quelque chose que personne n'a vérifié : ce
 * bandeau ne dit donc rien quand il n'y a rien à dire.
 *
 * ## Il ne se ferme pas
 *
 * Aucune croix, volontairement. Une alerte qu'on peut faire taire est une
 * alerte qu'on fera taire, et on retombe sur la nuit du 24. Elle disparaît
 * quand l'item est résolu dans l'inbox · c'est-à-dire quand quelqu'un s'en est
 * occupé, pas quand quelqu'un a été agacé.
 */
export function AlerteEnCours() {
  const queryClient = useQueryClient()

  const { data } = useQuery({
    queryKey: ['inbox', 'alertes-ouvertes'],
    queryFn: () => api.inbox.list({ status: 'open', type: 'alert' }),
    // Repli si le flux SSE est coupé : une alerte qui n'arrive pas parce que
    // la connexion temps réel est tombée serait exactement la panne que ce
    // bandeau existe pour rendre visible.
    refetchInterval: 60_000,
  })

  useEffect(() => {
    return subscribeToEvents((evt) => {
      if (evt.type === 'inbox.new' || evt.type === 'inbox.resolved') {
        void queryClient.invalidateQueries({ queryKey: ['inbox'] })
      }
    })
  }, [queryClient])

  const alertes = data ?? []
  if (alertes.length === 0) return null

  // La plus ancienne : c'est celle qui dure, donc celle qui compte. Une panne
  // ouverte depuis douze heures prime sur celle d'il y a deux minutes.
  const [premiere] = [...alertes].sort(
    (a, b) => new Date(a.blockedSince).getTime() - new Date(b.blockedSince).getTime(),
  )
  if (!premiere) return null

  const cause = typeof premiere.payload.cause === 'string' ? premiere.payload.cause : premiere.title
  const autres = alertes.length - 1

  return (
    <Link
      to="/inbox"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '9px 20px',
        borderBottom: '1px solid color-mix(in oklab, var(--sem-alert) 30%, transparent)',
        background: 'color-mix(in oklab, var(--sem-alert) 10%, var(--bg-0))',
        color: 'var(--text-hi)',
        textDecoration: 'none',
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          flexShrink: 0,
          borderRadius: 999,
          background: 'var(--sem-alert)',
          animation: 'chapoPulse 1.8s var(--ease) infinite',
        }}
      />
      <span
        style={{
          font: '600 10px var(--font-sans)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--sem-alert)',
          flexShrink: 0,
        }}
      >
        Alerte
      </span>
      <span style={{ fontSize: 13, minWidth: 0 }}>{cause}</span>
      {autres > 0 && (
        <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
          + {autres} autre{autres > 1 ? 's' : ''}
        </span>
      )}
      <div style={{ flex: 1 }} />
      <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-mid)', flexShrink: 0 }}>
        ouvrir l&rsquo;inbox →
      </span>
    </Link>
  )
}

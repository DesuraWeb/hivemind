import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ApiError, api } from '../../lib/api'

/**
 * « Écrire au client » · l'entrée manuelle du communicant.
 *
 * Le déclencheur automatique ne couvre qu'un cas : une mise en prod approuvée
 * fait proposer un email au client. Le reste du temps — une relance, un devis
 * à confirmer, une mauvaise nouvelle à annoncer — c'est Florian qui sait qu'il
 * faut écrire. Sans ce bouton, le communicant ne travaillerait que quand
 * quelque chose part en ligne, ce qui est rare.
 *
 * Le champ demande le SUJET, pas le texte. C'est le point : dicter le contenu
 * ferait du communicant un correcteur orthographique, alors que son intérêt
 * est d'aller lire la fiche client, d'en appliquer le ton, et de ne pas
 * redemander ce qui a déjà été répondu.
 *
 * Ce que ça produit n'est jamais un envoi : un brouillon dans la boîte de
 * Florian et une validation dans son inbox. Le bouton le dit, plutôt que de le
 * laisser découvrir.
 */
export function ClientEmail({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [sujet, setSujet] = useState('')

  const mutation = useMutation({
    mutationFn: (texte: string) => api.projects.communicant(projectId, texte),
    onSuccess: (result) => {
      if (result.inboxItemId) {
        setSujet('')
        void queryClient.invalidateQueries({ queryKey: ['inbox'] })
      }
    },
  })

  const erreur = messageErreur(mutation.error)
  const rienEcrit = mutation.isSuccess && !mutation.data.inboxItemId

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--bg-1)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
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
        Écrire au client
      </span>

      <textarea
        value={sujet}
        onChange={(e) => setSujet(e.target.value)}
        placeholder="De quoi parler · « relance sur la validation des visuels », « prévenir du décalage de la livraison »"
        rows={3}
        style={{
          width: '100%',
          resize: 'vertical',
          padding: '9px 11px',
          borderRadius: 'var(--r-md)',
          border: '1px solid var(--line)',
          background: 'var(--bg-0)',
          color: 'var(--text-hi)',
          font: '12.5px var(--font-sans)',
          lineHeight: 1.6,
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={sujet.trim().length < 3 || mutation.isPending}
          onClick={() => mutation.mutate(sujet.trim())}
          style={{
            padding: '7px 14px',
            borderRadius: 'var(--r-md)',
            border: '1px solid color-mix(in oklab, var(--accent) 50%, transparent)',
            background: 'transparent',
            color: 'var(--text-hi)',
            font: '500 12.5px var(--font-sans)',
            cursor: sujet.trim().length < 3 || mutation.isPending ? 'default' : 'pointer',
            opacity: sujet.trim().length < 3 || mutation.isPending ? 0.45 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {mutation.isPending ? 'rédaction en cours…' : 'Faire rédiger un brouillon'}
        </button>
        <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
          brouillon soumis à ta validation · rien ne part sans toi
        </span>
      </div>

      {mutation.isSuccess && mutation.data.inboxItemId && (
        <span style={{ font: '11.5px var(--font-mono)', color: 'var(--sem-ok, var(--accent))' }}>
          brouillon prêt ·{' '}
          <Link to="/inbox" style={{ textDecoration: 'underline' }}>
            le relire dans l'inbox →
          </Link>
        </span>
      )}

      {/* Un communicant qui décide de ne rien écrire n'est pas une panne :
          c'est la consigne (« un email inutile coûte plus cher qu'un email
          manquant »). On rapporte sa raison telle quelle. */}
      {rienEcrit && (
        <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
          aucun brouillon · {mutation.data.raison ?? 'rien à écrire à ce stade'}
        </span>
      )}

      {erreur && (
        <span style={{ font: '11.5px var(--font-mono)', color: 'var(--sem-alert)' }}>{erreur}</span>
      )}
    </div>
  )
}

/**
 * Le 422 « client_absent » mérite sa propre phrase : ce n'est pas une panne,
 * c'est un projet sans fiche client — et la fiche est ce qui porte le ton, qui
 * fait foi. Écrire sans elle produirait exactement le mail générique que ce
 * rôle existe pour éviter.
 */
function messageErreur(error: unknown): string | null {
  if (!error) return null
  if (error instanceof ApiError && error.status === 422) {
    return 'ce projet n’a pas de fiche client · sans elle, ni destinataire ni ton connus'
  }
  if (error instanceof ApiError && error.status === 502) {
    return 'la rédaction a échoué · réessaie'
  }
  return 'la rédaction a échoué'
}

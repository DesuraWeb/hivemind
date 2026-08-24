import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, type ServeurView, api } from '../../lib/api'
import { Note, Panel } from './Panel'

/**
 * Les serveurs auxquels l'agent d'exploitation parle (Phase 6).
 *
 * ## Ce que cet écran ne propose PAS, et c'est le point
 *
 * Aucun moyen de déclarer qu'un serveur est vierge. On l'enregistre, on
 * demande une sonde, et c'est la mesure qui tranche. Un sélecteur d'état ici
 * contournerait toute la phase en un clic : le champ libre s'ouvrirait sur le
 * serveur d'un client parce que quelqu'un a cliqué trop vite.
 *
 * L'état est donc en lecture seule, avec ses preuves : un verdict qui décide
 * de l'autonomie d'un agent doit pouvoir se contester.
 */

const COULEUR: Record<ServeurView['etat'], string> = {
  inconnu: 'var(--text-low)',
  vierge: 'var(--sem-question)',
  en_service: 'var(--ok)',
}

const LIBELLE: Record<ServeurView['etat'], string> = {
  inconnu: 'jamais mesuré · aucune autonomie',
  vierge: 'vierge · champ libre',
  en_service: 'en service · propose, valide, applique',
}

export function Serveurs() {
  const queryClient = useQueryClient()
  const { data, isPending, isError } = useQuery({
    queryKey: ['serveurs'],
    queryFn: api.serveurs.list,
  })
  const [ouvert, setOuvert] = useState(false)

  const serveurs = data ?? []

  return (
    <Panel label="Serveurs · exploitation">
      {isPending && <Note>lecture…</Note>}
      {isError && <Note>liste injoignable · réessai automatique</Note>}

      {!isPending && !isError && serveurs.length === 0 && (
        <Note>
          aucun serveur enregistré · l&rsquo;agent d&rsquo;exploitation n&rsquo;a nulle part où
          intervenir
        </Note>
      )}

      {serveurs.map((s) => (
        <LigneServeur key={s.id} serveur={s} />
      ))}

      <Note>
        l&rsquo;état se MESURE · il n&rsquo;existe aucun moyen de le déclarer ici, et un serveur
        passé « en service » ne redevient jamais vierge
      </Note>

      {ouvert ? (
        <Formulaire
          onFini={() => {
            setOuvert(false)
            void queryClient.invalidateQueries({ queryKey: ['serveurs'] })
          }}
          onAnnuler={() => setOuvert(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOuvert(true)}
          style={boutonStyle('1px solid var(--line-strong)')}
        >
          Enregistrer un serveur
        </button>
      )}
    </Panel>
  )
}

function LigneServeur({ serveur }: { serveur: ServeurView }) {
  const queryClient = useQueryClient()
  const [preuvesVisibles, setPreuvesVisibles] = useState(false)

  const sonde = useMutation({
    mutationFn: () => api.serveurs.sonde(serveur.id),
    onSuccess: () => {
      setPreuvesVisibles(true)
      void queryClient.invalidateQueries({ queryKey: ['serveurs'] })
    },
  })

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 2px',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            flexShrink: 0,
            borderRadius: 999,
            background: COULEUR[serveur.etat],
          }}
        />
        <span style={{ font: '12px var(--font-mono)', color: 'var(--text-hi)' }}>
          {serveur.nom}
        </span>
        <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
          {serveur.utilisateur}@{serveur.hote}
          {serveur.port !== 22 ? `:${serveur.port}` : ''}
        </span>
        <span style={{ font: '11px var(--font-mono)', color: COULEUR[serveur.etat] }}>
          {LIBELLE[serveur.etat]}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          disabled={sonde.isPending}
          onClick={() => sonde.mutate()}
          style={boutonStyle('1px solid var(--line)')}
        >
          {sonde.isPending ? 'mesure…' : 'Sonder'}
        </button>
      </div>

      <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
        {serveur.accesDepose
          ? `accès déposé · ${serveur.cleCoffre}`
          : `AUCUN accès · dépose la clé privée sous ${serveur.cleCoffre ?? 'ops.<nom>.ssh_private_key'}`}
        {serveur.mesureAt
          ? ` · mesuré le ${new Date(serveur.mesureAt).toLocaleDateString('fr-FR')}`
          : ' · jamais mesuré'}
      </span>

      {sonde.isError && (
        <span style={{ font: '11px var(--font-mono)', color: 'var(--sem-alert)' }}>
          sonde impossible · {sonde.error instanceof ApiError ? sonde.error.message : 'erreur'}
        </span>
      )}

      {/* Les preuves, pas seulement le verdict. C'est ce verdict qui décide de
          l'autonomie de l'agent : il doit pouvoir se contester. */}
      {preuvesVisibles && sonde.data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 16 }}>
          <span style={{ font: '11px var(--font-mono)', color: 'var(--text-mid)' }}>
            {sonde.data.raison}
          </span>
          {sonde.data.preuves.map((p) => (
            <span key={p.nom} style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
              {p.nom} · {p.verdict} · {p.detail}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Formulaire({ onFini, onAnnuler }: { onFini: () => void; onAnnuler: () => void }) {
  const [nom, setNom] = useState('')
  const [hote, setHote] = useState('')
  const [utilisateur, setUtilisateur] = useState('')
  const [url, setUrl] = useState('')

  const creer = useMutation({
    mutationFn: () =>
      api.serveurs.create({
        nom: nom.trim(),
        hote: hote.trim(),
        utilisateur: utilisateur.trim(),
        ...(url.trim() ? { url: url.trim() } : {}),
      }),
    onSuccess: onFini,
  })

  const pret = nom.trim().length > 0 && hote.trim().length > 0 && utilisateur.trim().length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
      <Champ
        valeur={nom}
        onChange={setNom}
        placeholder="nom court · [a-z0-9-], sert de clé de coffre"
      />
      <Champ valeur={hote} onChange={setHote} placeholder="hôte SSH" />
      <Champ valeur={utilisateur} onChange={setUtilisateur} placeholder="utilisateur SSH" />
      {/* Sans URL, la sonde perd une preuve — et perdre une preuve interdit le
          champ libre. Ce n'est pas un champ décoratif. */}
      <Champ valeur={url} onChange={setUrl} placeholder="URL publique à sonder (recommandé)" />

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          disabled={!pret || creer.isPending}
          onClick={() => creer.mutate()}
          style={{
            ...boutonStyle('1px solid color-mix(in oklab, var(--accent) 50%, transparent)'),
            opacity: pret && !creer.isPending ? 1 : 0.45,
          }}
        >
          Enregistrer
        </button>
        <button type="button" onClick={onAnnuler} style={boutonStyle('1px solid var(--line)')}>
          Annuler
        </button>
      </div>

      {creer.isError && (
        <span style={{ font: '11px var(--font-mono)', color: 'var(--sem-alert)' }}>
          {creer.error instanceof ApiError && creer.error.status === 409
            ? 'ce nom est déjà pris'
            : 'nom refusé · [a-z0-9-] uniquement, sans point ni espace (il porte la portée de la clé de coffre)'}
        </span>
      )}
    </div>
  )
}

function Champ({
  valeur,
  onChange,
  placeholder,
}: {
  valeur: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <input
      value={valeur}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        padding: '7px 10px',
        borderRadius: 'var(--r-md)',
        border: '1px solid var(--line)',
        background: 'var(--bg-0)',
        color: 'var(--text-hi)',
        font: '12px var(--font-mono)',
      }}
    />
  )
}

function boutonStyle(border: string) {
  return {
    padding: '6px 12px',
    borderRadius: 'var(--r-md)',
    border,
    background: 'transparent',
    color: 'var(--text-hi)',
    font: '500 12px var(--font-sans)',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  }
}

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { SectionHeader } from '../components/SectionHeader'
import { ClientDetail } from '../components/clients/ClientDetail'
import { ClientRow } from '../components/clients/ClientRow'
import { count } from '../components/clients/format'
import { api } from '../lib/api'

const CLIENTS_QUERY_KEY = ['clients'] as const
const PROJECTS_QUERY_KEY = ['projects'] as const

/**
 * Écran Clients (`docs/design/Clients.dc.html`), base de connaissances en
 * héros comme le demande CLAUDE.md : compteur géant, entrées en cascade sans
 * cadres, cartes d'info sans bordures.
 *
 * Branché sur `GET /api/clients`, qui rend la fiche entière. Trois écarts avec
 * le pack sont assumés côté serveur et se voient ici :
 *
 * - les savoirs sortent **sans version ni score de rappel** (`clients.notes` ne
 *   stocke que `{q, a, source_item_id, at}`) : le pack affiche « v2 » et
 *   « × 12 rappels », l'écran ne les remplace par rien — un « v1 » et un
 *   compteur à zéro laisseraient croire qu'un savoir n'a jamais servi alors
 *   qu'on ne le mesure pas. L'absence est dite une fois, sous le compteur ;
 * - `accessKeys` ne porte que les **noms** des accès : la section « Accès »
 *   liste ce qui existe, et dit qu'elle ne le révèle pas ;
 * - il n'existe **aucune route d'écriture** sur une fiche : « Éditer la
 *   fiche », « Réviser », « Révoquer » et « Restaurer » sont absents, pas
 *   désactivés en silence.
 *
 * La liste des projets est chargée en plus des fiches pour une seule raison :
 * la route `/globes/$globeId/$projectId` a besoin du globe d'accueil, que la
 * fiche client ne porte pas. Un projet dont le globe reste inconnu s'affiche
 * sans lien plutôt qu'avec un lien qui tomberait à côté.
 */
export function Clients() {
  const clientsQuery = useQuery({ queryKey: CLIENTS_QUERY_KEY, queryFn: api.clients.list })
  const projectsQuery = useQuery({ queryKey: PROJECTS_QUERY_KEY, queryFn: api.projects.list })

  const clients = useMemo(() => clientsQuery.data ?? [], [clientsQuery.data])

  const projectGlobes = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of projectsQuery.data ?? []) map.set(p.id, p.globe)
    return map
  }, [projectsQuery.data])

  const [pickedId, setPickedId] = useState<string | null>(null)
  // La sélection retombe sur la première fiche si celle qui était choisie
  // disparaît d'un rafraîchissement : jamais un panneau vide sans raison.
  const selected = clients.find((c) => c.id === pickedId) ?? clients[0] ?? null

  const totalKnowledge = clients.reduce((n, c) => n + c.knowledge.length, 0)
  const headerMeta =
    clients.length > 0
      ? `${count(clients.length, 'client', 'clients')} · ${count(
          totalKnowledge,
          'réponse archivée au total',
          'réponses archivées au total',
        )}`
      : undefined

  return (
    <>
      <SectionHeader label="Clients" meta={headerMeta} />
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          gap: 18,
          padding: '16px 20px 108px',
        }}
      >
        {clients.length > 0 && (
          <div
            style={{
              width: 270,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              overflowY: 'auto',
            }}
          >
            {clients.map((c) => (
              <ClientRow
                key={c.id}
                client={c}
                selected={selected?.id === c.id}
                onPick={setPickedId}
              />
            ))}
          </div>
        )}

        <section style={{ flex: 1, minWidth: 0, overflowY: 'auto', paddingRight: 4 }}>
          {selected ? (
            <ClientDetail client={selected} projectGlobes={projectGlobes} />
          ) : (
            <div
              style={{
                font: '11.5px var(--font-mono)',
                color: 'var(--text-low)',
                lineHeight: 1.9,
                paddingTop: 6,
              }}
            >
              {clientsQuery.isPending && 'chargement des fiches…'}
              {clientsQuery.isError && 'fiches injoignables · réessai automatique'}
              {!clientsQuery.isPending && !clientsQuery.isError && (
                <>
                  aucune fiche client
                  <br />
                  aucune route n&rsquo;en crée : une fiche se pose en base, puis l&rsquo;inbox la
                  remplit à chaque question résolue
                </>
              )}
            </div>
          )}
        </section>
      </main>
    </>
  )
}

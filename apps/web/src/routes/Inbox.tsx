import type { InboxType } from '@silithid/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { SectionHeader } from '../components/SectionHeader'
import { DetailPanel } from '../components/inbox/DetailPanel'
import { InboxList } from '../components/inbox/InboxList'
import { MobileSheet } from '../components/inbox/MobileSheet'
import { WEIGHT } from '../components/inbox/constants'
import { useIsMobile } from '../components/inbox/useIsMobile'
import { ageMinutes, formatAge } from '../lib/age'
import { type ProjectSummary, api } from '../lib/api'
import { subscribeToEvents } from '../lib/events'
import type { InboxItemView, InboxResponsePayload } from '../lib/inbox-types'

const INBOX_QUERY_KEY = ['inbox'] as const
const PROJECTS_QUERY_KEY = ['projects'] as const

/** Poids par type (alerte → question → validation → verdict), puis les plus anciens d'abord — Inbox.dc.html (Component.WEIGHT). */
function sortItems(items: InboxItemView[]): InboxItemView[] {
  return [...items].sort((a, b) => {
    const byWeight = WEIGHT[a.type] - WEIGHT[b.type]
    if (byWeight !== 0) return byWeight
    return ageMinutes(b.blockedSince) - ageMinutes(a.blockedSince)
  })
}

function isSavoir(item: InboxItemView): boolean {
  return item.type === 'approval' && item.sub === 'savoir'
}

/**
 * Écran Inbox (plan Phase 3, Task 7). Branché sur `GET /api/inbox` et
 * rafraîchi par `GET /api/events` (SSE) — jamais de polling : la liste
 * s'invalide sur `inbox.new`/`inbox.resolved`, React Query refait la
 * requête. Résoudre un item appelle réellement `POST /api/inbox/:id/resolve`,
 * qui relance la boucle bloquée le cas échéant (resolve.ts, Task 2).
 *
 * **Le triage tactile (`docs/design/Inbox mobile.dc.html`) est cet écran, pas
 * un autre.** Le prototype montre l'Inbox dans un cadre iPhone : le cadre est
 * un support de maquette, pas une interface. Ce qu'il décrit est le même
 * écran, les mêmes items et les mêmes routes, disposés autrement — une
 * colonne au lieu de deux, une feuille qui remonte au lieu d'un panneau
 * latéral. Une route `/inbox/mobile` aurait donné deux inbox à tenir en
 * parallèle et une URL qui ment sur son contenu ; un choix « appareil » à
 * faire à la main aurait donné un réglage de plus à se tromper. La bascule
 * suit donc la largeur disponible (`useIsMobile`), et l'adresse reste
 * `/inbox` : ouvrir le même lien depuis un téléphone donne l'écran tactile.
 *
 * Trois choses du prototype ne sont pas reprises. La barre d'onglets du bas
 * (Inbox · micro · Orbe) : le rail nav et le bandeau Hive tiennent déjà ces
 * rôles sur toutes les pages, en ajouter une troisième ferait deux barres.
 * Le toast « Traité · la boucle du Koin reprend » : `POST /resolve` rend
 * `runResumed`, mais l'item disparaît déjà de la liste, et l'écran de bureau
 * ne l'affiche pas non plus — le dire ici et pas là serait une divergence
 * gratuite. Le bouton « Détails sur le poste » : il n'y a rien de plus au
 * poste, c'est le même panneau.
 */
export function Inbox() {
  const queryClient = useQueryClient()
  const mobile = useIsMobile()
  const inboxQuery = useQuery({
    queryKey: INBOX_QUERY_KEY,
    queryFn: () => api.inbox.list({ status: 'open' }),
  })
  const projectsQuery = useQuery({ queryKey: PROJECTS_QUERY_KEY, queryFn: api.projects.list })

  const [activeType, setActiveType] = useState<'all' | InboxType>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [vanishing, setVanishing] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    return subscribeToEvents((evt) => {
      if (evt.type === 'inbox.new' || evt.type === 'inbox.resolved') {
        void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      }
      // Une question résolue peut faire repartir un run (run.state) : la
      // ligne de synthèse / le statut de boucle du projet peuvent changer.
      if (evt.type === 'run.state') {
        void queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY })
      }
    })
  }, [queryClient])

  const allItems = inboxQuery.data ?? []
  const mainItems = useMemo(() => allItems.filter((i) => !isSavoir(i)), [allItems])
  const savoirItems = useMemo(() => allItems.filter(isSavoir), [allItems])

  const visible = activeType === 'all' ? mainItems : mainItems.filter((i) => i.type === activeType)
  const sorted = useMemo(() => sortItems(visible), [visible])

  const counts = useMemo(() => {
    const c: Record<'all' | InboxType, number> = {
      all: mainItems.length,
      question: 0,
      approval: 0,
      verdict: 0,
      alert: 0,
      handoff: 0,
      info: 0,
    }
    for (const item of mainItems) c[item.type] += 1
    return c
  }, [mainItems])

  const projectsBySlug = useMemo(() => {
    const map = new Map<string, ProjectSummary>()
    for (const p of projectsQuery.data ?? []) map.set(p.id, p)
    return map
  }, [projectsQuery.data])

  const projectName = (slug: string | null): string =>
    slug ? (projectsBySlug.get(slug)?.name ?? slug) : '·'

  const selectedItem = allItems.find((i) => i.id === selectedId) ?? null

  // Sélection retombe sur rien si l'item sélectionné disparaît par une voie
  // qui n'est pas la nôtre (résolu ailleurs, SSE) — jamais bloquée sur un item
  // qui n'existe plus.
  useEffect(() => {
    if (selectedId && !vanishing.has(selectedId) && !allItems.some((i) => i.id === selectedId)) {
      setSelectedId(null)
    }
  }, [allItems, selectedId, vanishing])

  const resolveMutation = useMutation({
    mutationFn: ({ id, response }: { id: string; response: InboxResponsePayload }) =>
      api.inbox.resolve(id, response),
    onSuccess: (_result, vars) => {
      const idx = sorted.findIndex((i) => i.id === vars.id)
      const next = sorted[idx + 1] ?? sorted[idx - 1] ?? null
      setSelectedId(next ? next.id : null)
      setVanishing((s) => new Set(s).add(vars.id))
      // Même durée que Inbox.dc.html (var(--dur-3) = 250ms, marge à 280ms) :
      // laisse l'animation de disparition finir avant de retirer l'item du
      // cache — le SSE `inbox.resolved` (déjà publié par le serveur) peut
      // invalider la query plus tôt si un autre onglet ou l'auto-refetch
      // arrive avant : sans danger, les deux convergent vers le même état.
      setTimeout(() => {
        setVanishing((s) => {
          const next = new Set(s)
          next.delete(vars.id)
          return next
        })
        void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      }, 280)
    },
  })

  const decisions = mainItems.length
  const oldest = mainItems.reduce<InboxItemView | null>(
    (acc, i) => (!acc || ageMinutes(i.blockedSince) > ageMinutes(acc.blockedSince) ? i : acc),
    null,
  )
  // Au pouce, la ligne de méta est amputée de son détail le moins utile : la
  // largeur restante (l'écran moins le rail) ne la tient pas, et une phrase
  // coupée à mi-mot ne renseigne personne.
  const headerMeta =
    decisions > 0
      ? `${decisions} décision${decisions > 1 ? 's' : ''} · ~${Math.max(4, decisions * 3)} min${
          !mobile && oldest ? ` · plus ancienne ${formatAge(oldest.blockedSince)}` : ''
        }`
      : undefined

  const detail = (
    <DetailPanel
      item={selectedItem}
      projectName={projectName(selectedItem?.project ?? null)}
      resolving={resolveMutation.isPending}
      onResolve={(id, response) => resolveMutation.mutate({ id, response })}
      onClose={() => setSelectedId(null)}
      variant={mobile ? 'feuille' : 'colonne'}
    />
  )

  return (
    <>
      <SectionHeader label="Inbox" meta={headerMeta} />
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          gap: 18,
          // 108px en bas dans les deux dispositions : le bandeau Hive flotte
          // au-dessus du contenu, le dernier item doit rester atteignable.
          padding: mobile ? '12px 12px 108px' : '16px 20px 108px',
        }}
      >
        <InboxList
          items={sorted}
          savoirItems={savoirItems}
          counts={counts}
          activeType={activeType}
          onPickType={setActiveType}
          selectedId={selectedId}
          vanishing={vanishing}
          onPickItem={setSelectedId}
          projectName={projectName}
          fullWidth={mobile}
        />
        {!mobile && detail}
      </main>
      {mobile && (
        <MobileSheet open={selectedItem !== null} onClose={() => setSelectedId(null)}>
          {detail}
        </MobileSheet>
      )}
    </>
  )
}

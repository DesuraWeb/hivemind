import type { InboxType } from '@silithid/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { SectionHeader } from '../components/SectionHeader'
import { DetailPanel } from '../components/inbox/DetailPanel'
import { InboxList } from '../components/inbox/InboxList'
import { WEIGHT } from '../components/inbox/constants'
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
 * qui relance la boucle bloquée le cas échéant (resolve.ts, Task 2) — c'est
 * le critère de fin J7.
 */
export function Inbox() {
  const queryClient = useQueryClient()
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
  const headerMeta =
    decisions > 0
      ? `${decisions} décision${decisions > 1 ? 's' : ''} · ~${Math.max(4, decisions * 3)} min${
          oldest ? ` · plus ancienne ${formatAge(oldest.blockedSince)}` : ''
        }`
      : undefined

  return (
    <>
      <SectionHeader label="Inbox" meta={headerMeta} />
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          gap: 18,
          padding: '16px 20px 108px',
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
        />
        <DetailPanel
          item={selectedItem}
          projectName={projectName(selectedItem?.project ?? null)}
          resolving={resolveMutation.isPending}
          onResolve={(id, response) => resolveMutation.mutate({ id, response })}
          onClose={() => setSelectedId(null)}
        />
      </main>
    </>
  )
}

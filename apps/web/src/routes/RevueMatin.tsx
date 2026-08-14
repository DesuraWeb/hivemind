import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SectionHeader } from '../components/SectionHeader'
import { WEIGHT } from '../components/inbox/constants'
import { DoneScreen } from '../components/revue/DoneScreen'
import { QueueDots } from '../components/revue/QueueDots'
import { ReviewCard } from '../components/revue/ReviewCard'
import { Toast } from '../components/revue/Toast'
import { ageMinutes } from '../lib/age'
import { api } from '../lib/api'
import { subscribeToEvents } from '../lib/events'
import type { InboxItemView, InboxResponsePayload } from '../lib/inbox-types'

const INBOX_QUERY_KEY = ['inbox'] as const
const PROJECTS_QUERY_KEY = ['projects'] as const

/** Durée de la bascule entre deux cartes (`--dur-3` + marge), comme `_swap` du prototype. */
const SWAP_MS = 240
const TOAST_MS = 2600

/** Même ordre que l'Inbox (alerte → question → validation → verdict, plus anciens d'abord). */
function sortItems(items: InboxItemView[]): InboxItemView[] {
  return [...items].sort((a, b) => {
    const byWeight = WEIGHT[a.type] - WEIGHT[b.type]
    if (byWeight !== 0) return byWeight
    return ageMinutes(b.blockedSince) - ageMinutes(a.blockedSince)
  })
}

/** Les savoirs ne sont résolus par personne dans cette phase : les mettre en file bloquerait la revue. */
function isReviewable(item: InboxItemView): boolean {
  return !(item.type === 'approval' && item.sub === 'savoir')
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/**
 * Revue du matin (`docs/design/Revue du matin.dc.html`) : l'inbox traitée un
 * item à la fois, plein écran, **au clavier**.
 *
 * Ce n'est pas une source de données nouvelle : `GET /api/inbox` et
 * `POST /api/inbox/:id/resolve`, les mêmes que l'écran Inbox, et les mêmes
 * panneaux typés (cf. `components/revue/ReviewCard.tsx`). Ce qui change est la
 * présentation : une file ordonnée, une carte à la fois, un chrono.
 *
 * ## Le contrat clavier
 *
 * - `entrée` presse l'action principale du panneau courant ;
 * - `⌘/ctrl + entrée` fait la même chose depuis un champ de saisie (une
 *   `entrée` nue y reste une nouvelle ligne) ;
 * - `r` reporte : l'item repart en fin de file, il n'est ni résolu ni perdu ;
 * - `←` `→` naviguent sans rien décider ;
 * - `échap` quitte vers l'Inbox.
 *
 * Toute touche qui ne peut rien faire le **dit** (bandeau neutre) plutôt que
 * de rester muette : sans souris, une touche silencieuse est indiscernable
 * d'une panne.
 *
 * ## La file
 *
 * L'ordre est local à la revue (c'est lui que « reporter » réarrange) mais
 * réconcilié à chaque rafraîchissement : un item résolu ailleurs (autre
 * onglet, SSE) sort de la file, un item nouveau entre à la fin. On ne
 * conserve jamais dans la file un item qui n'existe plus côté serveur.
 */
export function RevueMatin() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const inboxQuery = useQuery({
    queryKey: INBOX_QUERY_KEY,
    queryFn: () => api.inbox.list({ status: 'open' }),
  })
  const projectsQuery = useQuery({ queryKey: PROJECTS_QUERY_KEY, queryFn: api.projects.list })

  const [order, setOrder] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [done, setDone] = useState(0)
  const [visible, setVisible] = useState(true)
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'neutre' } | null>(null)
  const [clock, setClock] = useState('00:00')

  const cardRef = useRef<HTMLDivElement>(null)
  const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (swapTimer.current) clearTimeout(swapTimer.current)
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  // Chrono de la revue : le temps passé depuis l'ouverture, pas l'heure.
  useEffect(() => {
    const t0 = Date.now()
    const id = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000)
      setClock(`${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    return subscribeToEvents((evt) => {
      if (evt.type === 'inbox.new' || evt.type === 'inbox.resolved') {
        void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      }
    })
  }, [queryClient])

  const itemsById = useMemo(() => {
    const map = new Map<string, InboxItemView>()
    for (const item of inboxQuery.data ?? []) {
      if (isReviewable(item)) map.set(item.id, item)
    }
    return map
  }, [inboxQuery.data])

  // Réconciliation de la file avec ce que le serveur rend : l'ordre local
  // survit (c'est lui que « reporter » a réarrangé), les disparus sortent, les
  // nouveaux entrent à la fin, triés comme dans l'Inbox.
  useEffect(() => {
    const data = inboxQuery.data
    if (!data) return
    const reviewable = data.filter(isReviewable)
    setOrder((prev) => {
      const present = new Set(reviewable.map((i) => i.id))
      const kept = prev.filter((id) => present.has(id))
      const known = new Set(kept)
      const added = sortItems(reviewable)
        .filter((i) => !known.has(i.id))
        .map((i) => i.id)
      const next = [...kept, ...added]
      return sameOrder(next, prev) ? prev : next
    })
  }, [inboxQuery.data])

  const queue = useMemo(
    () => order.flatMap((id) => (itemsById.has(id) ? [itemsById.get(id) as InboxItemView] : [])),
    [order, itemsById],
  )
  const safeIndex = queue.length === 0 ? 0 : Math.min(index, queue.length - 1)
  const current = queue[safeIndex] ?? null

  const projectName = (slug: string | null): string => {
    if (!slug) return '·'
    return projectsQuery.data?.find((p) => p.id === slug)?.name ?? slug
  }

  const flash = useCallback((text: string, tone: 'ok' | 'neutre') => {
    setToast({ text, tone })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  /** Bascule de carte : sortie en fondu, mutation, entrée — `_swap` du prototype. */
  const swap = useCallback((mutate: () => void) => {
    setVisible(false)
    if (swapTimer.current) clearTimeout(swapTimer.current)
    swapTimer.current = setTimeout(() => {
      mutate()
      setVisible(true)
    }, SWAP_MS)
  }, [])

  const resolveMutation = useMutation({
    mutationFn: ({ id, response }: { id: string; response: InboxResponsePayload }) =>
      api.inbox.resolve(id, response),
    onSuccess: (result, vars) => {
      // `runResumed` vient du serveur : on ne promet une boucle qui repart que
      // lorsqu'elle repart vraiment.
      const name = projectName(result.item.project)
      flash(
        result.runResumed
          ? `Traité · la boucle ${name} reprend`
          : 'Traité · aucune boucle à reprendre',
        'ok',
      )
      setDone((d) => d + 1)
      swap(() => {
        setOrder((o) => o.filter((id) => id !== vars.id))
        void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      })
    },
    onError: () => flash("La résolution a échoué · l'item reste dans la file", 'neutre'),
  })

  /** File vide : les trois raccourcis d'action le disent, plutôt que rien. */
  const EMPTY = 'Inbox à zéro · plus rien à traiter'

  const defer = useCallback(() => {
    if (queue.length === 0) {
      flash(EMPTY, 'neutre')
      return
    }
    if (queue.length < 2) {
      flash('Seul item de la file · rien derrière quoi le reporter', 'neutre')
      return
    }
    const id = queue[safeIndex]?.id
    if (!id) return
    swap(() => {
      setOrder((o) => [...o.filter((x) => x !== id), id])
      setIndex((i) => Math.min(i, queue.length - 2))
    })
  }, [queue, safeIndex, flash, swap])

  const nav = useCallback(
    (dir: 1 | -1) => {
      if (queue.length === 0) {
        flash(EMPTY, 'neutre')
        return
      }
      if (queue.length < 2) {
        flash('Un seul item · rien à parcourir', 'neutre')
        return
      }
      swap(() => setIndex((i) => (i + dir + queue.length) % queue.length))
    },
    [queue.length, flash, swap],
  )

  /**
   * « entrée » = presser l'action principale du panneau courant. Le panneau
   * détient l'état (réponse tapée, corps d'email édité) et le bouton qui sait
   * quoi en faire : on presse ce bouton plutôt que de reconstruire une action
   * par type ici, qui serait une seconde vérité.
   */
  const hasCurrent = current !== null
  const pressPrimary = useCallback(() => {
    if (!hasCurrent) {
      flash(EMPTY, 'neutre')
      return
    }
    const button = cardRef.current?.querySelector<HTMLButtonElement>('[data-panel-primary="true"]')
    if (!button) {
      // Un panneau sans action principale : le savoir (jamais alimenté) et
      // tout sous-type à venir dont personne n'a encore écrit la résolution.
      flash('Aucune action principale sur cet item · traitez-le depuis l’Inbox', 'neutre')
      return
    }
    if (button.disabled) {
      flash(`« ${button.textContent?.trim()} » indisponible · il manque une saisie`, 'neutre')
      return
    }
    button.click()
  }, [hasCurrent, flash])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.key.toLowerCase() === 'k') return // ⌘K reste à la palette
      const target = e.target as HTMLElement | null
      const typing =
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'INPUT' ||
        target?.isContentEditable === true
      if (typing) {
        // Dans un champ, `entrée` reste une nouvelle ligne : seul ⌘/ctrl+entrée
        // envoie (c'est ce que le placeholder du prototype annonce).
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          pressPrimary()
        }
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        pressPrimary()
      } else if (e.key === 'r' || e.key === 'R') {
        defer()
      } else if (e.key === 'ArrowRight') {
        nav(1)
      } else if (e.key === 'ArrowLeft') {
        nav(-1)
      } else if (e.key === 'Escape') {
        void navigate({ to: '/inbox' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pressPrimary, defer, nav, navigate])

  const running = projectsQuery.data
    ? projectsQuery.data.filter((p) => p.loop === 'run').length
    : null

  return (
    <>
      <SectionHeader
        label="Revue du matin"
        meta={
          <>
            <span>{clock}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 12 }}>
              <QueueDots items={queue} index={safeIndex} />
            </span>
            <span style={{ marginLeft: 12, color: 'var(--text-mid)' }}>
              {done} / {done + queue.length} traités
            </span>
          </>
        }
        right={
          <Link
            to="/inbox"
            style={{
              font: '500 12px var(--font-sans)',
              color: 'var(--text-low)',
              textDecoration: 'none',
            }}
          >
            Quitter la revue · esc
          </Link>
        }
      />

      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 28px',
        }}
      >
        {inboxQuery.isPending && (
          <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
            lecture de l&rsquo;inbox…
          </span>
        )}
        {inboxQuery.isError && (
          <span style={{ font: '11.5px var(--font-mono)', color: 'var(--sem-alert)' }}>
            inbox injoignable · rien n&rsquo;a été traité, la revue reprendra au prochain essai
          </span>
        )}
        {inboxQuery.isSuccess && current && (
          <ReviewCard
            key={current.id}
            item={current}
            projectName={projectName(current.project)}
            resolving={resolveMutation.isPending}
            onResolve={(response) => resolveMutation.mutate({ id: current.id, response })}
            onDefer={defer}
            cardRef={cardRef}
            visible={visible}
          />
        )}
        {inboxQuery.isSuccess && !current && (
          <DoneScreen done={done} clock={clock} running={running} />
        )}
      </main>

      {/* La légende des raccourcis, au-dessus du bandeau Hive que le Layout
          fait flotter en bas centre (le prototype la met sous son propre
          strip, en flux ; ici le strip est absolu et commun à tous les
          écrans). Le raccourci « entrée » ne peut pas se loger DANS le bouton
          principal comme dans le pack : ce bouton appartient au panneau
          réutilisé de l'Inbox. */}
      <footer
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          justifyContent: 'center',
          gap: 22,
          padding: '10px 14px 132px',
          flexShrink: 0,
          font: '10.5px var(--font-mono)',
          color: 'var(--text-low)',
        }}
      >
        <span>entrée · traiter</span>
        <span>⌘entrée · depuis un champ</span>
        <span>r · reporter</span>
        <span>← → · naviguer</span>
        <span>esc · quitter</span>
      </footer>

      <Toast text={toast?.text ?? null} tone={toast?.tone ?? 'ok'} />
    </>
  )
}

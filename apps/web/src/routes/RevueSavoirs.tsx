import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SectionHeader } from '../components/SectionHeader'
import { SavoirCard } from '../components/revue/SavoirCard'
import { Toast } from '../components/revue/Toast'
import { api } from '../lib/api'

const REVUE_QUERY_KEY = ['savoirs', 'revue'] as const

/** Repli d'une carte décidée (`--dur-3` + marge), comme `_close` du prototype. */
const CLOSE_MS = 300
const TOAST_MS = 2600

/**
 * La revue de péremption (`docs/design/Revue des savoirs.dc.html`).
 *
 * ## Ce qui est réutilisé, et ce qui ne pouvait pas l'être
 *
 * `SectionHeader`, `Toast` et les boutons de `PanelKit` viennent de la Revue du
 * matin et de l'Inbox : même vocabulaire visuel, mêmes cibles tactiles. Le
 * pilotage clavier reprend son contrat (une touche qui ne peut rien faire le
 * DIT, plutôt que de rester muette — sans souris, une touche silencieuse est
 * indiscernable d'une panne).
 *
 * Ce qui n'a pas pu être repris : `ReviewCard`, `QueueDots` et `DoneScreen`
 * sont typés sur `InboxItemView` et parlent de boucles à reprendre. Un savoir
 * n'est pas un item d'inbox — il n'a ni run, ni projet, ni step, et rien ne
 * redémarre quand on le traite. Et surtout la FORME diffère : la Revue du
 * matin montre une carte à la fois parce qu'une décision y engage une boucle ;
 * le pack de la revue des savoirs affiche la liste entière, parce que juger
 * qu'un savoir est périmé demande de voir les voisins. On garde donc la liste
 * du pack, avec un curseur clavier dessus.
 *
 * ## Les non-traités reviennent
 *
 * Il n'y a pas de session de revue : la file est recalculée à chaque ouverture
 * (`GET /api/savoirs/revue`). Quitter en cours de route ne perd rien, et le
 * lien « Quitter » n'a donc rien à sauvegarder.
 *
 * ## Ce que l'écran ne dit pas
 *
 * Le pack promet « prochaine revue : novembre · Hive vous préviendra dans le
 * brief ». **Rien ne planifie ni ne prévient aujourd'hui** : aucun job, aucun
 * item d'inbox. Cette ligne est donc remplacée par ce qui est vrai — les
 * savoirs confirmés reviennent après 90 jours, et c'est l'ouverture de cet
 * écran qui déclenche la revue, rien d'autre.
 */
export function RevueSavoirs() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const revueQuery = useQuery({ queryKey: REVUE_QUERY_KEY, queryFn: api.savoirs.revue })

  /** Racines décidées pendant cette visite : masquées avant même le rafraîchissement. */
  const [traites, setTraites] = useState<string[]>([])
  const [vanishing, setVanishing] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [done, setDone] = useState(0)
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'neutre' } | null>(null)

  const cardRefs = useRef(new Map<string, HTMLDivElement | null>())
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  const flash = useCallback((text: string, tone: 'ok' | 'neutre') => {
    setToast({ text, tone })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  const vue = revueQuery.data
  const file = useMemo(
    () => (vue?.items ?? []).filter((s) => !traites.includes(s.racineId)),
    [vue, traites],
  )
  const affichees = useMemo(
    () =>
      (vue?.items ?? []).filter(
        (s) => !traites.includes(s.racineId) || vanishing.includes(s.racineId),
      ),
    [vue, traites, vanishing],
  )
  // Restant réel : le total serveur moins ce qui vient d'être décidé et que le
  // rafraîchissement n'a pas encore retiré. Se recale tout seul au refetch.
  const enAttente = (vue?.items ?? []).filter((s) => traites.includes(s.racineId)).length
  const restant = vue ? Math.max(vue.aRevoir - enAttente, 0) : 0
  const safeIndex = file.length === 0 ? 0 : Math.min(index, file.length - 1)
  const courant = file[safeIndex] ?? null

  // Le curseur suit la file quand elle raccourcit, et la carte visée reste
  // visible : un curseur hors écran ne se distingue pas d'un curseur absent.
  useEffect(() => {
    if (!courant) return
    cardRefs.current.get(courant.racineId)?.scrollIntoView({ block: 'nearest' })
  }, [courant])

  const decision = useMutation({
    // Les deux gestes ne rendent pas la même chose (`revueAt` d'un côté,
    // `archive` de l'autre) et l'écran n'en lit ni l'un ni l'autre : ce qu'il
    // affiche vient de `vars`, donc du geste demandé. Rien n'est déduit d'une
    // réponse qu'on n'utilise pas.
    mutationFn: async ({
      racineId,
      geste,
    }: { racineId: string; geste: 'garder' | 'archiver' }): Promise<void> => {
      if (geste === 'garder') await api.savoirs.garder(racineId)
      else await api.savoirs.archiver(racineId)
    },
    onSuccess: (_data, vars) => {
      flash(
        vars.geste === 'garder'
          ? `Gardé · confirmé aujourd’hui, il reviendra dans ${vue?.periodeJours ?? 90} jours`
          : 'Archivé · retiré du rappel, ses versions restent lisibles',
        'ok',
      )
      setDone((d) => d + 1)
      setVanishing((v) => [...v, vars.racineId])
      setTraites((t) => [...t, vars.racineId])
      if (closeTimer.current) clearTimeout(closeTimer.current)
      closeTimer.current = setTimeout(() => {
        setVanishing((v) => v.filter((x) => x !== vars.racineId))
        void queryClient.invalidateQueries({ queryKey: REVUE_QUERY_KEY })
      }, CLOSE_MS)
    },
    // Rien n'est masqué en cas d'échec : le savoir est toujours là, et la carte
    // reste, plutôt que de disparaître sur une décision qui n'a pas eu lieu.
    onError: () => flash('Le geste a échoué · le savoir reste dans la revue', 'neutre'),
  })

  const decider = useCallback(
    (geste: 'garder' | 'archiver') => {
      if (!courant) {
        flash('Plus rien à revoir · la file est vide', 'neutre')
        return
      }
      if (decision.isPending) return
      decision.mutate({ racineId: courant.racineId, geste })
    },
    [courant, decision, flash],
  )

  const nav = useCallback(
    (dir: 1 | -1) => {
      if (file.length === 0) {
        flash('Plus rien à revoir · la file est vide', 'neutre')
        return
      }
      if (file.length < 2) {
        flash('Un seul savoir · rien à parcourir', 'neutre')
        return
      }
      setIndex((i) => (Math.min(i, file.length - 1) + dir + file.length) % file.length)
    },
    [file.length, flash],
  )

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.key.toLowerCase() === 'k') return // ⌘K reste à la palette
      const target = e.target as HTMLElement | null
      // Le bandeau Hive est un champ de saisie posé sur tous les écrans : y
      // taper « a » ne doit pas archiver un savoir.
      if (
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'INPUT' ||
        target?.isContentEditable === true
      ) {
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        decider('garder')
      } else if (e.key === 'a' || e.key === 'A') {
        decider('archiver')
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault()
        nav(1)
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault()
        nav(-1)
      } else if (e.key === 'Escape') {
        void navigate({ to: '/clients' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [decider, nav, navigate])

  return (
    <>
      <SectionHeader
        label="Revue des savoirs · trimestre"
        meta={
          vue ? (
            <>
              {restant > 0 ? `${restant} à revoir` : 'plus rien à revoir'}
              {` · ${vue.actifs} savoir${vue.actifs > 1 ? 's' : ''} actif${vue.actifs > 1 ? 's' : ''}`}
              {/* La file est plafonnée : le dire, plutôt que de laisser croire
                  que tout tient à l'écran. */}
              {vue.aRevoir > vue.items.length ? ` · ${vue.items.length} affichés` : ''}
              {done > 0 ? ` · ${done} traité${done > 1 ? 's' : ''}` : ''}
            </>
          ) : undefined
        }
        right={
          <Link
            to="/clients"
            style={{
              font: '500 12px var(--font-sans)',
              color: 'var(--text-low)',
              textDecoration: 'none',
            }}
          >
            Quitter · les non-traités reviendront
          </Link>
        }
      />

      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          // Pas de réserve pour le bandeau Hive ici : c'est le pied de page qui
          // la porte (`padding-bottom: 132px`), et la doubler ajouterait 132 px
          // de vide à faire défiler après la dernière carte.
          padding: '6px 28px 24px',
        }}
      >
        <div
          style={{
            maxWidth: 720,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          {revueQuery.isPending && (
            <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
              lecture de la mémoire…
            </span>
          )}
          {revueQuery.isError && (
            <span style={{ font: '11.5px var(--font-mono)', color: 'var(--sem-alert)' }}>
              mémoire injoignable · rien n&rsquo;a été décidé, la revue reprendra au prochain essai
            </span>
          )}

          {vue && (
            <p
              style={{
                margin: 0,
                fontSize: 14.5,
                fontWeight: 500,
                lineHeight: 1.7,
                color: 'var(--text-mid)',
                textWrap: 'pretty',
              }}
            >
              Hive · « {vue.hive} »
            </p>
          )}

          {vue && affichees.length === 0 && !revueQuery.isFetching && (
            <FinDeRevue actifs={vue.actifs} periodeJours={vue.periodeJours} done={done} />
          )}

          {affichees.map((s) => {
            const rang = file.findIndex((x) => x.racineId === s.racineId)
            return (
              <SavoirCard
                key={s.racineId}
                savoir={s}
                focused={rang !== -1 && rang === safeIndex}
                vanishing={vanishing.includes(s.racineId)}
                busy={decision.isPending}
                onGarder={() => decision.mutate({ racineId: s.racineId, geste: 'garder' })}
                onArchiver={() => decision.mutate({ racineId: s.racineId, geste: 'archiver' })}
                onFocus={() => {
                  if (rang !== -1) setIndex(rang)
                }}
                cardRef={(el) => {
                  if (el) cardRefs.current.set(s.racineId, el)
                  else cardRefs.current.delete(s.racineId)
                }}
              />
            )
          })}
        </div>
      </main>

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
        <span>entrée · garder</span>
        <span>a · archiver</span>
        <span>↑ ↓ · naviguer</span>
        <span>esc · quitter</span>
      </footer>

      <Toast text={toast?.text ?? null} tone={toast?.tone ?? 'ok'} />
    </>
  )
}

/**
 * Fin de revue et installation neuve, dans le même bloc (`sc-if empty` du
 * pack) : dans les deux cas il n'y a rien à trancher, seule la raison diffère.
 *
 * Le pack écrit ici « prochaine revue : novembre · Hive vous préviendra dans le
 * brief ». Aucun job ne planifie cette revue et aucun item d'inbox ne la
 * rappelle : la ligne dit donc ce qui est vrai · un savoir confirmé revient
 * après la période, et c'est vous qui ouvrez cet écran.
 */
function FinDeRevue({
  actifs,
  periodeJours,
  done,
}: {
  actifs: number
  periodeJours: number
  done: number
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        padding: '60px 20px',
        textAlign: 'center',
      }}
    >
      <svg width="34" height="34" viewBox="0 0 30 30" fill="none" aria-hidden="true">
        <circle cx="15" cy="15" r="13" stroke="var(--ok)" strokeWidth="1.4" />
        <path
          d="M9.5 15.5l3.6 3.6 7.4-8"
          stroke="var(--ok)"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span style={{ fontSize: 16, fontWeight: 600 }}>
        {/* « Mémoire saine » est le titre du pack, et il ne vaut que pour une
            mémoire qui EXISTE : sur une installation neuve il n'y a rien dont
            on puisse dire qu'il va bien. */}
        {done > 0 ? 'Revue terminée' : actifs === 0 ? 'Mémoire vide' : 'Mémoire saine'}
      </span>
      <span
        style={{
          font: '11.5px var(--font-mono)',
          color: 'var(--text-low)',
          lineHeight: 1.7,
          maxWidth: 460,
        }}
      >
        {actifs === 0
          ? 'aucun savoir archivé pour l’instant · la revue s’alimentera quand la mémoire se remplira'
          : `${actifs} savoir${actifs > 1 ? 's' : ''} actif${actifs > 1 ? 's' : ''} · confirmé${actifs > 1 ? 's' : ''} il y a moins de ${periodeJours} jours`}
        <br />
        rien ne planifie ni ne prévient · un savoir confirmé revient ici après {periodeJours} jours
      </span>
      <Link
        to="/"
        style={{
          marginTop: 8,
          padding: '10px 20px',
          borderRadius: 'var(--r-md)',
          background: 'var(--accent)',
          color: 'var(--accent-ink)',
          font: '600 13.5px var(--font-sans)',
          textDecoration: 'none',
        }}
      >
        Retour au dashboard
      </Link>
    </div>
  )
}

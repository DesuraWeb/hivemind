import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { formatTokens } from '../components/project/steps'
import { RunControls } from '../components/run/RunControls'
import { RunFeed } from '../components/run/RunFeed'
import { RunPipeline } from '../components/run/RunPipeline'
import { useRunClock } from '../components/run/clock'
import { buildFeed } from '../components/run/feed'
import type { InstructableRole } from '../components/run/instruct'
import { activeRole, buildPipeline, runStateTone } from '../components/run/state'
import { ApiError, api } from '../lib/api'
import { subscribeToEvents } from '../lib/events'

/** `run_8f3a2c` du pack : nos identifiants sont des uuid, on n'en garde que la tête. */
function shortId(id: string): string {
  return `run_${id.slice(0, 6)}`
}

/**
 * Ce qu'on affiche quand une commande échoue.
 *
 * Un 409 n'est pas une panne : c'est la machine à états qui refuse le geste
 * parce que le run a bougé entre-temps (terminé, déjà repris, passé en pause
 * budgétaire). On le dit comme tel, et la vue se rafraîchit derrière.
 */
function commandError(err: unknown, action: string): string {
  // Formulations sans accord en genre : `action` est un groupe nominal
  // (« Mise en pause », « Arrêt », « Consigne ») et la phrase doit rester juste
  // pour les quatre.
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return `${action} : l’état du run ne le permet plus · l’écran vient d’être rafraîchi`
    }
    if (err.status === 404) return `${action} : run introuvable · il a peut-être été supprimé`
    return `${action} : ${err.message}`
  }
  return `${action} : le serveur est injoignable`
}

/**
 * Run en direct (`docs/design/Run en direct.dc.html`).
 *
 * L'écran qui manquait le plus : voir une boucle avancer, et reprendre la main
 * dessus. Quatre choses réelles y sont montrées — le pipeline garant → dev →
 * reviewer → juge, les passations du bus dans l'ordre, les compteurs, et les
 * quatre gestes de contrôle (pause, reprise, arrêt, consigne).
 *
 * ## Ce qui n'est pas rendu, et pourquoi
 *
 * - **Le coût en euros** du header du pack. Le taux (`pricing.eur_per_mtok`)
 *   est un réglage serveur ; le recopier ici créerait une seconde source de
 *   vérité qui dériverait au premier changement. Même parti que `RunsList`.
 * - **Les événements « mémoire · rappel gratuit »** du pack : rien côté
 *   serveur n'émet ce genre de message, la cascade mémoire n'est pas branchée.
 * - **Le micro de dictée** : aucune transcription n'existe dans le produit.
 *
 * ## Rafraîchissement
 *
 * Par le SSE existant (`run.state` quand la machine bouge, `run.message` quand
 * la timeline seule change), jamais par du polling. Le chrono, lui, s'anime
 * localement : le serveur rend `durationSeconds: null` tant que le run tourne,
 * précisément pour ne pas figer une durée à l'instant de la requête.
 */
export function RunLive() {
  const { runId } = useParams({ from: '/runs/$runId' })
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [posted, setPosted] = useState<{ role: string; readAt: string } | null>(null)

  const runQuery = useQuery({ queryKey: ['run', runId], queryFn: () => api.runs.get(runId) })
  const run = runQuery.data ?? null
  const projectId = run?.project.id ?? null

  // Le fil d'Ariane et le nombre total de steps viennent de la fiche projet :
  // `GET /api/runs/:id` rend le projet (id, nom) mais ni son globe ni son
  // découpage complet.
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    enabled: projectId !== null,
    queryFn: () => {
      if (projectId === null) throw new Error('projet inconnu')
      return api.projects.get(projectId)
    },
  })
  const globesQuery = useQuery({ queryKey: ['globes'], queryFn: api.globes.list })

  useEffect(() => {
    return subscribeToEvents((evt) => {
      if ((evt.type === 'run.state' || evt.type === 'run.message') && evt.runId === runId) {
        void queryClient.invalidateQueries({ queryKey: ['run', runId] })
        // La fiche projet dérive son badge de l'état du run : la laisser
        // périmée ferait lire « en cours » sur une boucle qu'on vient
        // d'arrêter depuis cet écran.
        if (evt.type === 'run.state') {
          void queryClient.invalidateQueries({ queryKey: ['project', evt.projectId] })
        }
      }
    })
  }, [queryClient, runId])

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['run', runId] })
    if (projectId) void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
  }

  const pauseMutation = useMutation({
    mutationFn: () => api.runs.pause(runId),
    onSuccess: () => {
      setError(null)
      refresh()
    },
    onError: (err) => {
      setError(commandError(err, 'Mise en pause'))
      refresh()
    },
  })

  const resumeMutation = useMutation({
    mutationFn: () => api.runs.resume(runId),
    onSuccess: () => {
      setError(null)
      setPosted(null)
      refresh()
    },
    onError: (err) => {
      setError(commandError(err, 'Reprise'))
      refresh()
    },
  })

  const stopMutation = useMutation({
    mutationFn: () => api.runs.stop(runId, 'arrêt demandé depuis « Run en direct »'),
    onSuccess: () => {
      setError(null)
      refresh()
    },
    onError: (err) => {
      setError(commandError(err, 'Arrêt'))
      refresh()
    },
  })

  /**
   * Le geste complet, dans l'ordre : pause d'abord quand la boucle avance,
   * consigne ensuite. Écrire la consigne sans mettre en pause la ferait
   * attendre le prochain tour sans que personne l'ait décidé — et si la pause
   * échoue, on n'écrit rien : mieux vaut ne pas avoir posé la consigne que
   * l'avoir posée en croyant la boucle arrêtée.
   */
  const instructMutation = useMutation({
    mutationFn: async (vars: { role: InstructableRole; text: string; pauseFirst: boolean }) => {
      if (vars.pauseFirst) await api.runs.pause(runId)
      return api.runs.instruct(runId, vars.role, vars.text)
    },
    onSuccess: (result, vars) => {
      setError(null)
      setPosted({ role: vars.role, readAt: result.readAt })
      refresh()
    },
    onError: (err) => {
      setError(commandError(err, 'Consigne'))
      refresh()
    },
  })

  const feed = useMemo(() => (run ? buildFeed(run) : []), [run])
  const clock = useRunClock(
    run?.startedAt ?? new Date().toISOString(),
    run?.durationSeconds ?? null,
  )

  if (runQuery.isError) {
    return (
      <div style={{ padding: '18px 26px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ font: '11.5px var(--font-mono)', color: 'var(--sem-alert)' }}>
          run introuvable · {runId}
        </span>
        <Link to="/globes" style={{ font: '500 12.5px var(--font-sans)' }}>
          ← retour aux globes
        </Link>
      </div>
    )
  }

  if (!run) {
    return (
      <div
        style={{ padding: '18px 26px', font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}
      >
        chargement…
      </div>
    )
  }

  const tone = runStateTone(run.state)
  const pipeline = buildPipeline(run)
  const project = projectQuery.data ?? null
  const globeSlug = project?.globe ?? null
  const globeName = globesQuery.data?.find((g) => g.id === globeSlug)?.name ?? globeSlug
  const totalSteps = project?.step[1] ?? null

  const projectLink =
    globeSlug !== null ? (
      <Link
        to="/globes/$globeId/$projectId"
        params={{ globeId: globeSlug, projectId: run.project.id }}
        style={{ font: 'inherit', letterSpacing: 'inherit', color: 'var(--text-mid)' }}
      >
        {run.project.name}
      </Link>
    ) : (
      <span style={{ color: 'var(--text-mid)' }}>{run.project.name}</span>
    )

  return (
    <>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '16px 26px',
          flexShrink: 0,
          borderBottom: '1px solid var(--line)',
          minWidth: 0,
        }}
      >
        <span
          style={{
            font: '600 10.5px var(--font-mono)',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--text-low)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <Link to="/globes" style={{ font: 'inherit', letterSpacing: 'inherit' }}>
            Globes
          </Link>
          {globeSlug !== null && (
            <>
              {' / '}
              <Link
                to="/globes/$globeId"
                params={{ globeId: globeSlug }}
                style={{ font: 'inherit', letterSpacing: 'inherit' }}
              >
                {globeName}
              </Link>
            </>
          )}
          {' / '}
          {projectLink}
        </span>

        <span
          style={{
            font: '500 14px var(--font-sans)',
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {shortId(run.id)} · step {run.step.position}
          {totalSteps !== null ? `/${totalSteps}` : ''} · {run.step.title}
        </span>

        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            font: '11px var(--font-mono)',
            color: tone.color,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: tone.color,
              animation: tone.pulse ? 'chapoPulse 1.8s var(--ease) infinite' : 'none',
            }}
          />
          {tone.label}
        </span>

        <span
          title={
            run.durationSeconds === null
              ? 'temps écoulé depuis le démarrage · il court aussi pendant une pause'
              : 'durée totale du run, calculée par le serveur'
          }
          style={{
            font: '11.5px var(--font-mono)',
            color: 'var(--text-mid)',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          itér. {run.iteration[0]}/{run.iteration[1]} · {clock} · {formatTokens(run.costTokens)} tok
        </span>
      </header>

      <RunPipeline nodes={pipeline} />

      <RunFeed
        entries={feed}
        empty={
          <div
            style={{
              font: '11.5px var(--font-mono)',
              color: 'var(--text-low)',
              lineHeight: 1.8,
              padding: '10px 0',
            }}
          >
            aucune passation écrite pour l’instant
            <br />
            {tone.phase === 'ended'
              ? 'ce run s’est terminé sans qu’aucun message n’ait été écrit dans le bus'
              : `la première apparaîtra quand le ${
                  pipeline.find((n) => n.status === 'active')?.label ?? 'garant'
                } aura rendu sa passation · cet écran se met à jour tout seul`}
          </div>
        }
        banner={
          tone.phase === 'ended' ? (
            <EndBanner
              state={run.state}
              projectName={run.project.name}
              projectLink={globeSlug !== null ? { globeSlug, projectId: run.project.id } : null}
            />
          ) : undefined
        }
      />

      <RunControls
        phase={tone.phase}
        state={run.state}
        activeRole={activeRole(run)}
        pausing={pauseMutation.isPending}
        resuming={resumeMutation.isPending}
        stopping={stopMutation.isPending}
        instructing={instructMutation.isPending}
        error={error}
        posted={posted}
        onPause={() => pauseMutation.mutate()}
        onResume={() => resumeMutation.mutate()}
        onStop={() => stopMutation.mutate()}
        onInstruct={(role, text, pauseFirst) => instructMutation.mutate({ role, text, pauseFirst })}
        onDismissPosted={() => setPosted(null)}
      />
    </>
  )
}

/**
 * La fin de course d'un run, dite pour ce qu'elle est.
 *
 * Le pack n'a qu'une bannière, rouge, pour l'arrêt (« Boucle stoppée à votre
 * demande · reprise possible depuis la fiche projet »). Deux corrections :
 *
 * - **la couleur** : `stopped` est une décision, pas une panne. Le rouge est
 *   gardé pour `failed`, l'arrêt reçoit un ton neutre. Confondre les deux
 *   ferait lire « échec » sur un geste volontaire.
 * - **la phrase** : un run arrêté ne se « reprend » pas, l'état est terminal.
 *   Ce qui est vrai, c'est que le step est de nouveau libre et qu'une NOUVELLE
 *   boucle peut y être lancée.
 */
function EndBanner({
  state,
  projectName,
  projectLink,
}: {
  state: string
  projectName: string
  projectLink: { globeSlug: string; projectId: string } | null
}) {
  const tone =
    state === 'failed'
      ? {
          color: 'var(--sem-alert)',
          text: 'Boucle en échec · le détail est dans la dernière passation ci-dessus.',
        }
      : state === 'done'
        ? { color: 'var(--ok)', text: 'Boucle terminée · le step est allé au bout de son verdict.' }
        : {
            color: 'var(--text-low)',
            text: 'Boucle stoppée à votre demande · ce n’est pas un échec. Le step est de nouveau libre : une nouvelle boucle peut y être lancée.',
          }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        padding: '12px 16px',
        borderLeft: `3px solid ${tone.color}`,
        background: `color-mix(in oklab, ${tone.color} 6%, transparent)`,
        borderRadius: 4,
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{tone.text}</span>
      {projectLink && (
        <Link
          to="/globes/$globeId/$projectId"
          params={{ globeId: projectLink.globeSlug, projectId: projectLink.projectId }}
          style={{ font: '500 12.5px var(--font-sans)', whiteSpace: 'nowrap' }}
        >
          Fiche {projectName} →
        </Link>
      )}
    </div>
  )
}

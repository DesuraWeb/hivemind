import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { badgeFor } from '../components/dashboard/loop'
import { SEM } from '../components/inbox/constants'
import { ClientEmail } from '../components/project/ClientEmail'
import { RunsList } from '../components/project/RunsList'
import { StepList } from '../components/project/StepList'
import { StepTimeline } from '../components/project/StepTimeline'
import {
  elapsedSince,
  formatRunTime,
  isRunActive,
  latestRun,
  runTone,
  shortRunId,
} from '../components/project/runs'
import { formatTokens } from '../components/project/steps'
import { api } from '../lib/api'
import { subscribeToEvents } from '../lib/events'

const TABS = [
  ['apercu', "Vue d'ensemble"],
  ['steps', 'Steps'],
  ['boucles', 'Boucles'],
] as const

type TabId = (typeof TABS)[number][0]

/**
 * Fiche d'un projet (pack DA : `Projet.dc.html`).
 *
 * Route `/globes/$globeId/$projectId` : elle prolonge l'intérieur de globe et
 * reproduit le fil d'Ariane imposé par CLAUDE.md (« Projet.dc.html breadcrumb
 * Globes / Desura / projet »). Le slug du globe est dans l'URL, donc le fil
 * d'Ariane se rend sans attendre le moindre appel réseau.
 *
 * Écart assumé au pack : le prototype porte cinq onglets. « Config » (repo,
 * plafond budget, branche de travail) n'a aucune route qui l'alimente, en
 * lecture comme en écriture. « Équipe » demande les rôles DU PROJET et leur
 * dérive au template ; `GET /api/role-templates` ne rend que les templates
 * globaux, pas cette dérive. Aucun des deux n'est rendu plutôt que rendu vide
 * ou meublé d'inventions. Les trois onglets restants sont tous alimentés par
 * de vraies données.
 */
export function Project() {
  const { globeId, projectId } = useParams({ from: '/globes/$globeId/$projectId' })
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<TabId>('apercu')

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.projects.get(projectId),
  })
  const stepsQuery = useQuery({
    queryKey: ['project', projectId, 'steps'],
    queryFn: () => api.projects.steps(projectId),
  })
  const runsQuery = useQuery({
    queryKey: ['project', projectId, 'runs'],
    queryFn: () => api.projects.runs(projectId),
  })
  const inboxQuery = useQuery({
    queryKey: ['inbox', 'project', projectId],
    queryFn: () => api.inbox.list({ status: 'open', project: projectId }),
  })
  const globesQuery = useQuery({ queryKey: ['globes'], queryFn: api.globes.list })

  useEffect(() => {
    return subscribeToEvents((evt) => {
      if (evt.type === 'inbox.new' || evt.type === 'inbox.resolved') {
        void queryClient.invalidateQueries({ queryKey: ['inbox'] })
      }
      if (evt.type === 'run.state' || evt.type === 'inbox.resolved') {
        void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      }
    })
  }, [queryClient, projectId])

  const project = projectQuery.data
  const steps = useMemo(() => stepsQuery.data ?? [], [stepsQuery.data])
  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data])
  const inboxItems = useMemo(() => inboxQuery.data ?? [], [inboxQuery.data])

  const globeName = globesQuery.data?.find((g) => g.id === globeId)?.name ?? globeId

  if (projectQuery.isError) {
    return (
      <div style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ font: '11.5px var(--font-mono)', color: 'var(--sem-alert)' }}>
          projet introuvable · {projectId}
        </span>
        <Link
          to="/globes/$globeId"
          params={{ globeId }}
          style={{ font: '500 12.5px var(--font-sans)' }}
        >
          ← retour au globe {globeName}
        </Link>
      </div>
    )
  }

  if (!project) {
    return (
      <div
        style={{ padding: '18px 24px', font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}
      >
        chargement…
      </div>
    )
  }

  const badge = badgeFor(project.loop)
  const current = latestRun(runs)
  const activeRun = current && isRunActive(current.state) ? current : null
  const activeStep = activeRun ? steps.find((s) => s.id === activeRun.stepId) : undefined
  const runningIteration: [number, number] | null =
    activeRun && activeStep ? [activeRun.iteration, activeStep.maxIterations] : null

  return (
    <>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 20,
          padding: '18px 24px 0',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <Link
            to="/globes"
            style={{ font: '500 12px var(--font-sans)', color: 'var(--text-low)' }}
          >
            Globes
          </Link>
          <span style={{ color: 'var(--text-low)' }}>/</span>
          <Link
            to="/globes/$globeId"
            params={{ globeId }}
            style={{ font: '500 12px var(--font-sans)', color: 'var(--text-low)' }}
          >
            {globeName}
          </Link>
          <span style={{ color: 'var(--text-low)' }}>/</span>
          <span
            style={{
              width: 9,
              height: 9,
              flexShrink: 0,
              borderRadius: 999,
              background: project.tint ?? 'var(--pause)',
            }}
          />
          <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>
            {project.name}
          </span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              font: '10.5px var(--font-mono)',
              color: 'var(--text-low)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: badge.color,
                animation: badge.pulse ? 'chapoPulse 1.8s var(--ease) infinite' : 'none',
              }}
            />
            {badge.label}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            font: '11.5px var(--font-mono)',
            color: 'var(--text-low)',
            flexShrink: 0,
          }}
        >
          {/* Le pack affiche aussi « repo ↗ » et « PR #142 ↗ ». `repo_full_name`
              existe en base mais n'est pas rendu par `GET /api/projects/:id`, et
              le numéro de PR appartient à un run, pas au projet : on n'affiche
              que ce dont on dispose réellement. */}
          {project.staging && (
            <a
              href={project.staging}
              target="_blank"
              rel="noreferrer"
              style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}
            >
              {project.staging.replace(/^https?:\/\//, '')} ↗
            </a>
          )}
        </div>
      </header>

      <div style={{ display: 'flex', gap: 4, padding: '14px 24px 0', flexShrink: 0 }}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            style={{
              padding: '7px 14px',
              borderRadius: 'var(--r-md) var(--r-md) 0 0',
              border: 'none',
              borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}`,
              background: 'transparent',
              color: tab === id ? 'var(--text-hi)' : 'var(--text-mid)',
              font: '500 13px var(--font-sans)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              transition: 'all var(--dur-1) var(--ease)',
            }}
          >
            {label}
          </button>
        ))}
        <div style={{ flex: 1, borderBottom: '1px solid var(--line)' }} />
      </div>

      <main style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 24px 116px' }}>
        {tab === 'apercu' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 1060 }}>
            <StepTimeline steps={steps} runningIteration={runningIteration} />

            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
              <div
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--r-lg)',
                  background: 'var(--bg-1)',
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                <div
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <span
                    style={{
                      font: '600 10.5px var(--font-mono)',
                      letterSpacing: '0.18em',
                      textTransform: 'uppercase',
                      color: 'var(--text-mid)',
                    }}
                  >
                    Boucle en cours
                  </span>
                  {activeRun && (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        font: '10.5px var(--font-mono)',
                        color: 'var(--text-mid)',
                      }}
                    >
                      <span
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: 999,
                          background: badge.color,
                          animation: badge.pulse ? 'chapoPulse 1.8s var(--ease) infinite' : 'none',
                        }}
                      />
                      {/* « dev au travail » (le pack) n'est vrai que si la boucle
                          avance : sur un run en attente humain, personne ne
                          travaille — on nomme alors l'état, pas un agent. */}
                      {project.loop === 'run' && project.role
                        ? `${project.role} au travail`
                        : badge.label}
                    </span>
                  )}
                </div>

                {activeRun ? (
                  <>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>
                      Step {activeStep ? activeStep.position : '·'}/{project.step[1]}
                      {activeStep ? ` · ${activeStep.title}` : ''}
                      {runningIteration
                        ? ` · itération ${runningIteration[0]}/${runningIteration[1]}`
                        : ''}
                    </div>
                    <div
                      style={{
                        font: '11.5px var(--font-mono)',
                        color: 'var(--text-mid)',
                        lineHeight: 1.8,
                      }}
                    >
                      {shortRunId(activeRun.id)} · démarré {formatRunTime(activeRun.startedAt)} ·{' '}
                      {elapsedSince(activeRun.startedAt)}
                      <br />
                      garant → dev → reviewer → juge · {formatTokens(activeRun.costTokens)} tokens
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 2, alignItems: 'center' }}>
                      {/* Le geste attendu depuis cette carte n'est pas de lire
                          une liste : c'est d'aller voir la boucle avancer et
                          de pouvoir reprendre la main dessus. */}
                      <Link
                        to="/runs/$runId"
                        params={{ runId: activeRun.id }}
                        style={{
                          padding: '7px 14px',
                          borderRadius: 'var(--r-md)',
                          border: '1px solid color-mix(in oklab, var(--accent) 50%, transparent)',
                          font: '500 12.5px var(--font-sans)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Suivre en direct →
                      </Link>
                      <button
                        type="button"
                        onClick={() => setTab('boucles')}
                        style={{
                          padding: '7px 14px',
                          borderRadius: 'var(--r-md)',
                          border: '1px solid var(--line-strong)',
                          background: 'transparent',
                          color: 'var(--text-hi)',
                          font: '500 12.5px var(--font-sans)',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Voir les boucles
                      </button>
                    </div>
                  </>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div
                      style={{
                        font: '11.5px var(--font-mono)',
                        color: 'var(--text-low)',
                        lineHeight: 1.8,
                      }}
                    >
                      {/* « terminée » était écrit pour tout run non actif :
                          faux pour un arrêt, et faux pour un échec. On nomme
                          l'état réel, celui-là même que rend la liste. */}
                      {current
                        ? `dernière boucle ${shortRunId(current.id)} · ${formatRunTime(current.startedAt)} · ${runTone(current.state).label}`
                        : 'aucune boucle démarrée sur ce projet'}
                    </div>
                    <button
                      type="button"
                      onClick={() => setTab('steps')}
                      style={{
                        alignSelf: 'flex-start',
                        padding: '7px 14px',
                        borderRadius: 'var(--r-md)',
                        border: '1px solid color-mix(in oklab, var(--accent) 50%, transparent)',
                        background: 'transparent',
                        color: 'var(--accent)',
                        font: '500 12.5px var(--font-sans)',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Démarrer une boucle →
                    </button>
                  </div>
                )}
              </div>

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
                  En attente humain
                </span>
                {inboxItems.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 13,
                      color: 'var(--text-mid)',
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        flexShrink: 0,
                        borderRadius: 999,
                        background: SEM[item.type],
                      }}
                    />
                    <span>{item.title}</span>
                  </div>
                ))}
                {inboxItems.length === 0 && (
                  <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
                    rien n&rsquo;attend de vous sur ce projet
                  </span>
                )}
                {inboxItems.length > 0 && (
                  <Link
                    to="/inbox"
                    style={{ font: '500 12.5px var(--font-sans)', marginTop: 'auto' }}
                  >
                    Ouvrir dans l&rsquo;inbox →
                  </Link>
                )}
              </div>
            </div>

            {/* Le communicant travaille tout seul quand une mise en prod est
                approuvée. Le reste du temps — une relance, un devis, une
                mauvaise nouvelle — c'est d'ici qu'on le réveille. */}
            <ClientEmail projectId={projectId} />

            {/* Le pack ajoute « budget projet 3 % de la fenêtre 7 j » : le suivi
                budgétaire par projet n'est pas exposé cette phase, on s'arrête
                à ce qui est vrai. */}
            <div style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
              conso du projet {project.conso} · {runs.length} boucle{runs.length > 1 ? 's' : ''}{' '}
              jouée{runs.length > 1 ? 's' : ''}
            </div>
          </div>
        )}

        {tab === 'steps' && <StepList steps={steps} runs={runs} projectId={projectId} />}
        {tab === 'boucles' && <RunsList runs={runs} steps={steps} />}
      </main>
    </>
  )
}

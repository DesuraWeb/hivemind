import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { OrbCanvas } from '../components/OrbCanvas'
import { IdentityCard } from '../components/creation/IdentityCard'
import { GlobePrepPanel, InfraPanel } from '../components/creation/InfraPanel'
import { MemoryColumn } from '../components/creation/MemoryColumn'
import { StepsColumn } from '../components/creation/StepsColumn'
import { TeamOrbit } from '../components/creation/TeamOrbit'
import {
  type GlobeDraft,
  type ProjectDraft,
  type StepDraft,
  emptyStep,
  initialProjectDraft,
  projectProblems,
  toCreateProjectInput,
} from '../components/creation/draft'
import { FRAGMENT_LABEL } from '../components/creation/kit'
import {
  type CreationMode,
  FINAL_STAGE,
  GLOBE_TINTS,
  INTRO_TEXT,
  scriptOf,
} from '../components/creation/script'
import { ApiError, type CreateProjectInput, api } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import type { OscilloscopeInstance } from '../vendor/oscilloscope'
import { create as createOscilloscope } from '../vendor/oscilloscope'

const GLOBES_QUERY_KEY = ['globes'] as const
const PROJECTS_QUERY_KEY = ['projects'] as const
const CLIENTS_QUERY_KEY = ['clients'] as const
const ROLE_TEMPLATES_QUERY_KEY = ['role-templates'] as const

/** L'orbe de Hive au centre de la scène : config exacte du prototype. */
const HIVE_CLUSTER = [{ id: 'hive', name: 'Hive', tint: '#7FD9CF', nodes: 400 }]
const ORB_CONFIG = {
  PARTICLE_COUNT: 3400,
  VEIL_RATIO: 0.55,
  CLUSTER_SPREAD: 1.1,
  SHELL_THICKNESS: 0.1,
  PARTICLE_SIZE: 0.06,
  SIZE_MAX: 1.7,
  ALPHA: 0.8,
  TINT_MIX: 0.35,
  ROT_SPEED: 0.14,
  WOBBLE: 0.06,
  JITTER_AMPL: 0.05,
  PARALLAX: 0.02,
  CAMERA_Z: 3.4,
  HOVER_RADIUS_NDC: 0,
}

const FIELD_LABELS: Record<string, string> = {
  name: 'nom',
  globe: 'globe',
  repoFullName: 'dépôt',
  clientId: 'client',
  stack: 'stack',
  tint: 'teinte',
  stagingUrl: 'staging',
  title: 'intitulé',
  specs: 'specs',
  autonomy: 'mode de boucle',
  maxIterations: 'itérations',
}

/** `steps.2.specs` → « step 03 · specs ». Le champ fautif se lit sans décoder un chemin. */
function fieldLabel(path: string): string {
  const parts = path.split('.')
  if (parts[0] === 'steps' && parts.length >= 3) {
    const num = String(Number(parts[1]) + 1).padStart(2, '0')
    const leaf = parts[2] ?? ''
    return `step ${num} · ${FIELD_LABELS[leaf] ?? leaf}`
  }
  return FIELD_LABELS[path] ?? path
}

/**
 * Ce que le serveur a refusé, champ par champ. `details` porte les `issues`
 * zod : c'est la seule façon de dire « le dépôt n'est pas au bon format »
 * plutôt que « requête invalide ».
 */
function errorLines(error: unknown): string[] {
  if (!(error instanceof ApiError)) return ['création impossible · le serveur est injoignable']
  if (error.status === 404) return ['globe introuvable · rechargez la liste des globes']
  if (error.details.length > 0)
    return error.details.map((d) => `${fieldLabel(d.path)} · ${d.message}`)
  return [error.message]
}

/**
 * Scène de Création (`docs/design/Creation.dc.html`), projet et globe.
 *
 * ## Ce que l'écran fait, et ce qu'il ne prétend pas faire
 *
 * La mise en scène du pack est reprise telle quelle dans sa forme : orbe de
 * Hive au centre, choix « Un projet / Un globe » au démarrage, oscilloscope au
 * ralenti tant qu'on n'a pas choisi, fragments qui se matérialisent au fil des
 * `stage`, équipe en orbite, CTA final, « ⟲ rejouer la conversation ».
 *
 * Ce qui change, ce sont les affirmations. Le prototype fait dire à Hive qu'il
 * a challengé une stack, réglé des boucles, créé un dépôt GitHub et un staging
 * — et fait parler Florian. Aucun agent n'écoute cet écran, et
 * `POST /api/projects` écrit un projet et ses steps, rien d'autre. Les
 * répliques sont donc réécrites (`creation/script.ts`), le fragment
 * « Infra & accès » ne coche plus rien (`creation/InfraPanel.tsx`), et
 * l'héritage mémoire du globe redevient une description de la cascade
 * (`creation/MemoryColumn.tsx`). Chaque écart est justifié à l'endroit où il
 * est pris.
 *
 * ## La mise en scène ne bloque personne
 *
 * Les délais du pack (jusqu'à 15 s en mode projet) découvrent les fragments un
 * à un. Quiconque touche un champ, ou clique « passer », saute directement au
 * dernier `stage` : les minuteurs sont coupés, tout est découvert, le CTA est
 * là. Personne n'attend la fin d'une animation pour créer un projet.
 *
 * ## Le brouillon survit à l'échec
 *
 * `project` et `globe` sont des états locaux, jamais dérivés du script ni
 * remis à zéro par lui : un 400 du serveur affiche le champ fautif sous le
 * CTA et laisse la fiche intacte. « Rejouer la conversation » rejoue la
 * narration seule, elle non plus n'efface rien.
 */
export function Creation() {
  const search = useSearch({ from: '/creation' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { me } = useAuth()

  const globesQuery = useQuery({ queryKey: GLOBES_QUERY_KEY, queryFn: api.globes.list })
  const clientsQuery = useQuery({ queryKey: CLIENTS_QUERY_KEY, queryFn: api.clients.list })
  const rolesQuery = useQuery({
    queryKey: ROLE_TEMPLATES_QUERY_KEY,
    queryFn: api.roleTemplates.list,
  })
  const globes = globesQuery.data ?? []

  const [mode, setMode] = useState<CreationMode | null>(search.mode ?? null)
  const [stage, setStage] = useState(0)
  const [sceneText, setSceneText] = useState('')
  const [userLine, setUserLine] = useState('')
  const [micOn, setMicOn] = useState(false)
  const [hiveText, setHiveText] = useState('')
  const [project, setProject] = useState<ProjectDraft>(() =>
    initialProjectDraft(search.globe ?? ''),
  )
  const [globe, setGlobe] = useState<GlobeDraft>({ name: '', color: GLOBE_TINTS[0] })

  // Le globe d'accueil par défaut ne peut être choisi qu'une fois la liste
  // arrivée. On ne l'impose jamais par-dessus un choix déjà fait.
  useEffect(() => {
    setProject((prev) => {
      if (prev.globe !== '' || globes.length === 0) return prev
      const first = globes[0]
      return first ? { ...prev, globe: first.id } : prev
    })
  }, [globes])

  const oscHostRef = useRef<HTMLDivElement>(null)
  const oscRef = useRef<OscilloscopeInstance | null>(null)
  const oscTimer = useRef(0)
  const timers = useRef<number[]>([])

  useEffect(() => {
    const host = oscHostRef.current
    if (!host) return
    const osc = createOscilloscope(host, { state: 'idle' })
    oscRef.current = osc
    return () => {
      osc.destroy()
      oscRef.current = null
    }
  }, [])

  /** Hive « parle » 2,3 s puis retombe au repos — sauf si le micro écoute. */
  const speak = useCallback(() => {
    const osc = oscRef.current
    if (!osc || osc.state === 'listen') return
    osc.setState('speak')
    window.clearTimeout(oscTimer.current)
    oscTimer.current = window.setTimeout(() => {
      const current = oscRef.current
      if (current && current.state === 'speak') current.setState('idle')
    }, 2300)
  }, [])

  const clearTimers = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id)
    timers.current = []
  }, [])

  useEffect(() => {
    return () => {
      clearTimers()
      window.clearTimeout(oscTimer.current)
    }
  }, [clearTimers])

  const play = useCallback(
    (next: CreationMode) => {
      clearTimers()
      setMode(next)
      setStage(0)
      setSceneText('')
      for (const step of scriptOf(next)) {
        timers.current.push(
          window.setTimeout(() => {
            setStage(step.stage)
            setSceneText(step.text)
            speak()
          }, step.at),
        )
      }
    },
    [clearTimers, speak],
  )

  const intro = useCallback(() => {
    clearTimers()
    setMode(null)
    setStage(0)
    setSceneText(INTRO_TEXT)
    setUserLine('')
    speak()
  }, [clearTimers, speak])

  const modeRef = useRef(mode)
  modeRef.current = mode
  const stageRef = useRef(stage)
  stageRef.current = stage

  /** Sauter la mise en scène : tout est découvert, tout de suite. */
  const skip = useCallback(() => {
    const current = modeRef.current
    if (!current) return
    clearTimers()
    const script = scriptOf(current)
    const last = script[script.length - 1]
    setStage(FINAL_STAGE[current])
    if (last) setSceneText(last.text)
  }, [clearTimers])

  /** Toute saisie vaut « j'ai compris, montre-moi le reste ». */
  const reveal = useCallback(() => {
    const current = modeRef.current
    if (current && stageRef.current < FINAL_STAGE[current]) skip()
  }, [skip])

  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (search.mode) play(search.mode)
    else intro()
  }, [search.mode, play, intro])

  const createProject = useMutation({
    mutationFn: (input: CreateProjectInput) => api.projects.create(input),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: GLOBES_QUERY_KEY })
      void navigate({
        to: '/globes/$globeId/$projectId',
        params: { globeId: created.globeSlug, projectId: created.slug },
      })
    },
  })

  const createGlobe = useMutation({
    mutationFn: (input: { name: string; color: string }) => api.globes.create(input),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: GLOBES_QUERY_KEY })
      void navigate({ to: '/globes/$globeId', params: { globeId: created.id } })
    },
  })

  /**
   * Un geste de saisie : il découvre le reste de la scène et efface l'échec
   * précédent. Un message d'erreur qui survit à la correction du champ qu'il
   * dénonce est un message qui ment d'une frappe de retard.
   *
   * Fonctions simples et non mémoïsées : elles dépendent des mutations, dont
   * l'identité change à chaque rendu, et aucun des composants qui les reçoit
   * n'est mémoïsé.
   */
  function touch() {
    reveal()
    if (createProject.isError) createProject.reset()
    if (createGlobe.isError) createGlobe.reset()
  }

  function patchProject(patch: Partial<ProjectDraft>) {
    touch()
    setProject((prev) => ({ ...prev, ...patch }))
  }

  function patchGlobe(patch: Partial<GlobeDraft>) {
    touch()
    setGlobe((prev) => ({ ...prev, ...patch }))
  }

  function patchStep(id: string, patch: Partial<StepDraft>) {
    touch()
    setProject((prev) => ({
      ...prev,
      steps: prev.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }))
  }

  function addStep() {
    touch()
    setProject((prev) => ({ ...prev, steps: [...prev.steps, emptyStep()] }))
  }

  function removeStep(id: string) {
    touch()
    setProject((prev) => ({ ...prev, steps: prev.steps.filter((s) => s.id !== id) }))
  }

  const isProjet = mode === 'projet'
  const isGlobe = mode === 'globe'
  const final = mode !== null && stage >= FINAL_STAGE[mode]
  const pending = createProject.isPending || createGlobe.isPending
  const problems = isProjet
    ? projectProblems(project)
    : globe.name.trim() === ''
      ? ['le nom du globe']
      : []
  const failure = createProject.error ?? createGlobe.error

  function submit() {
    if (problems.length > 0 || pending) return
    if (isProjet) createProject.mutate(toCreateProjectInput(project))
    else createGlobe.mutate({ name: globe.name.trim(), color: globe.color })
  }

  const fragment1: CSSProperties = {
    position: 'absolute',
    left: 32,
    top: 26,
    width: 316,
    zIndex: 6,
    opacity: stage >= 1 && mode ? 1 : 0,
    transform: `translateY(${stage >= 1 && mode ? '0px' : '14px'})`,
    transition: 'opacity 600ms var(--ease), transform 600ms var(--ease-out)',
    pointerEvents: stage >= 1 && mode ? 'auto' : 'none',
  }

  const fragment2: CSSProperties = {
    position: 'absolute',
    right: 32,
    top: 26,
    width: 372,
    zIndex: 6,
    maxHeight: 'calc(100% - 52px)',
    overflowY: 'auto',
    paddingRight: 4,
    pointerEvents: stage >= 2 && mode ? 'auto' : 'none',
  }

  // Le fragment du bas apparaît au stage qui le raconte (4 en projet, final en
  // globe) — le pack ne le découvre qu'au dernier stage tout en lui donnant
  // `pointer-events: auto` dès le stage 4, ce qui n'est cohérent qu'ici.
  const bottomShown = isProjet ? stage >= 4 : final
  const fragment4: CSSProperties = {
    position: 'absolute',
    left: 32,
    bottom: 28,
    width: 400,
    zIndex: 6,
    opacity: bottomShown ? 1 : 0,
    transform: `translateY(${bottomShown ? '0px' : '14px'})`,
    transition: 'opacity 600ms var(--ease), transform 600ms var(--ease-out)',
    pointerEvents: bottomShown ? 'auto' : 'none',
  }

  return (
    <div
      style={{
        position: 'relative',
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 20,
          padding: '18px 24px 0',
          flexShrink: 0,
          zIndex: 7,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span
            style={{
              font: '600 10.5px var(--font-mono)',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--text-mid)',
            }}
          >
            {isProjet ? 'Création · projet' : isGlobe ? 'Création · globe' : 'Création'}
          </span>
          <span
            style={{
              font: '11.5px var(--font-mono)',
              color: 'var(--text-low)',
              whiteSpace: 'nowrap',
            }}
          >
            la fiche se matérialise autour de la conversation
          </span>
        </div>
        <Link to="/globes" style={{ font: '500 12px var(--font-sans)', color: 'var(--text-low)' }}>
          Annuler
        </Link>
      </header>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {/* La colonne centrale se centre au-dessus du CTA, pas au milieu du
            cadre entier : le pack la centre sur `inset: 0` et pose le bouton
            « Créer » en surimpression du bas, ce qui ne tient qu'au-delà de
            ~850 px de haut. Constaté à l'écran en 1280×720 : le bouton passait
            exactement sous le champ « écrivez à Hive ». La réserve vaut la
            hauteur du bloc CTA (bouton + note + marge). */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            paddingBottom: 84,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              position: 'relative',
              width: 268,
              height: 268,
              animation: 'chapoBob 6s ease-in-out infinite',
            }}
          >
            <OrbCanvas projects={HIVE_CLUSTER} config={ORB_CONFIG} />
            {isProjet && <TeamOrbit revealed={stage >= 3} templates={rolesQuery.data ?? []} />}
          </div>

          <div
            style={{
              minHeight: 18,
              font: '12.5px var(--font-mono)',
              color: 'var(--text-low)',
              opacity: userLine ? 1 : 0,
              transition: 'opacity var(--dur-3) var(--ease)',
              maxWidth: 620,
              textAlign: 'center',
            }}
          >
            {userLine || ' '}
          </div>

          <div
            style={{
              maxWidth: 640,
              padding: '0 20px',
              textAlign: 'center',
              fontSize: 19,
              fontWeight: 500,
              lineHeight: 1.6,
              color: 'var(--text-hi)',
              textWrap: 'pretty',
              minHeight: 62,
            }}
          >
            {sceneText}
          </div>

          {mode === null && (
            <div style={{ display: 'flex', gap: 12, pointerEvents: 'auto' }}>
              <button
                type="button"
                onClick={() => play('projet')}
                className="creation-cta"
                style={{
                  padding: '12px 26px',
                  borderRadius: 'var(--r-full)',
                  border: '1px solid transparent',
                  background: 'var(--accent)',
                  color: 'var(--accent-ink)',
                  font: '600 14px var(--font-sans)',
                  cursor: 'pointer',
                }}
              >
                Un projet
              </button>
              <button
                type="button"
                onClick={() => play('globe')}
                className="creation-ghost"
                style={{
                  padding: '12px 26px',
                  borderRadius: 'var(--r-full)',
                  border: '1px solid var(--line-strong)',
                  background: 'rgba(9, 14, 22, 0.6)',
                  color: 'var(--text-hi)',
                  font: '600 14px var(--font-sans)',
                  cursor: 'pointer',
                }}
              >
                Un globe
              </button>
            </div>
          )}

          <div
            style={{
              width: 420,
              height: 52,
              opacity: mode === null ? 0.35 : 1,
              transition: 'opacity var(--dur-3) var(--ease)',
            }}
          >
            <div ref={oscHostRef} style={{ width: '100%', height: '100%' }} />
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              pointerEvents: 'auto',
              opacity: mode === null ? 0.35 : 1,
              transition: 'opacity var(--dur-3) var(--ease)',
            }}
          >
            <button
              type="button"
              onClick={() => {
                const next = !micOn
                setMicOn(next)
                oscRef.current?.setState(next ? 'listen' : 'idle')
              }}
              title="Parler à Hive"
              aria-pressed={micOn}
              className="hive-mic-btn"
              style={{
                width: 54,
                height: 54,
                borderRadius: 999,
                border: `1px solid ${micOn ? 'transparent' : 'var(--glass-border)'}`,
                background: micOn ? 'var(--accent)' : 'var(--glass-bg)',
                color: micOn ? 'var(--accent-ink)' : 'var(--text-mid)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all var(--dur-2) var(--ease)',
              }}
            >
              <svg width="21" height="21" viewBox="0 0 17 17" fill="none" aria-hidden="true">
                <rect
                  x="6"
                  y="1.8"
                  width="5"
                  height="8.4"
                  rx="2.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path
                  d="M3.4 8.2a5.1 5.1 0 0 0 10.2 0M8.5 13.3v2"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <input
              className="hive-input"
              value={hiveText}
              onChange={(e) => setHiveText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const said = hiveText.trim()
                if (said === '') return
                // On affiche ce qui a été écrit, et on dit tout de suite que
                // personne ne l'a lu : aucun agent n'est branché sur cet écran.
                // Une réponse simulée de Hive serait une conversation inventée.
                setUserLine(`${me.login} · « ${said} » · Hive ne traite pas encore la conversation`)
                setHiveText('')
              }}
              type="text"
              placeholder="ou écrivez à Hive…"
              aria-label="Écrire à Hive"
              style={{
                width: 320,
                background: 'rgba(9, 14, 22, 0.6)',
                border: '1px solid var(--line-strong)',
                borderRadius: 'var(--r-full)',
                padding: '13px 20px',
                font: '500 14px var(--font-sans)',
                color: 'var(--text-hi)',
                outline: 'none',
              }}
            />
          </div>
        </div>

        {mode !== null && (
          <IdentityCard
            style={fragment1}
            mode={mode}
            project={project}
            globe={globe}
            globes={globes}
            clients={clientsQuery.data ?? []}
            onProject={patchProject}
            onGlobe={patchGlobe}
          />
        )}

        {isProjet && (
          <StepsColumn
            style={fragment2}
            revealed={stage >= 2}
            steps={project.steps}
            onPatch={patchStep}
            onAdd={addStep}
            onRemove={removeStep}
          />
        )}
        {isGlobe && <MemoryColumn style={fragment2} revealed={stage >= 2} />}

        {isProjet && <InfraPanel style={fragment4} draft={project} onPatch={patchProject} />}
        {isGlobe && <GlobePrepPanel style={fragment4} />}

        {mode !== null && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 26,
              zIndex: 7,
              transform: `translateX(-50%) translateY(${final ? '0px' : '14px'})`,
              opacity: final ? 1 : 0,
              transition: 'opacity 600ms var(--ease), transform 600ms var(--ease-out)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
              pointerEvents: final ? 'auto' : 'none',
              maxWidth: 460,
            }}
          >
            <button
              type="button"
              onClick={submit}
              disabled={pending || problems.length > 0}
              className="creation-cta"
              title={problems.length > 0 ? `il manque ${problems.join(' · ')}` : undefined}
              style={{
                padding: '14px 34px',
                borderRadius: 'var(--r-full)',
                border: '1px solid transparent',
                background: 'var(--accent)',
                color: 'var(--accent-ink)',
                font: '600 15px var(--font-sans)',
                cursor: pending || problems.length > 0 ? 'default' : 'pointer',
                whiteSpace: 'nowrap',
                boxShadow: '0 0 28px var(--accent-glow)',
                opacity: pending || problems.length > 0 ? 0.55 : 1,
              }}
            >
              {pending ? 'Création…' : isGlobe ? 'Créer le globe' : 'Créer le projet'}
            </button>
            <span
              style={{
                font: '11.5px var(--font-mono)',
                color: 'var(--text-low)',
                textAlign: 'center',
                lineHeight: 1.6,
              }}
            >
              {problems.length > 0
                ? `il manque ${problems.join(' · ')}`
                : isGlobe
                  ? "un globe de plus · rien d'autre ne change"
                  : "le projet et ses steps sont enregistrés · aucun dépôt ni staging n'est créé"}
            </span>
            {failure && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  font: '11.5px var(--font-mono)',
                  color: 'var(--sem-alert)',
                  textAlign: 'center',
                }}
              >
                {errorLines(failure).map((line) => (
                  <span key={line}>{line}</span>
                ))}
                <span style={{ color: 'var(--text-low)' }}>
                  rien n'a été créé · la fiche est intacte
                </span>
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => (mode !== null && !final ? skip() : intro())}
          className="creation-ghost"
          style={{
            position: 'absolute',
            right: 28,
            bottom: 24,
            zIndex: 7,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            font: '500 11px var(--font-mono)',
            color: 'var(--text-low)',
            padding: 4,
          }}
        >
          {mode !== null && !final ? 'passer la mise en scène →' : '⟲ rejouer la conversation'}
        </button>

        {globesQuery.isSuccess && globes.length === 0 && isProjet && (
          <span
            style={{
              ...FRAGMENT_LABEL,
              position: 'absolute',
              left: 32,
              bottom: 8,
              color: 'var(--sem-question)',
            }}
          >
            aucun globe · créez-en un d'abord
          </span>
        )}
      </div>
    </div>
  )
}

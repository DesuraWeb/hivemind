import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { OrbCanvas } from '../components/OrbCanvas'
import { IdentityCard } from '../components/creation/IdentityCard'
import { InfraPanel } from '../components/creation/InfraPanel'
import { StepsColumn } from '../components/creation/StepsColumn'
import { TeamOrbit } from '../components/creation/TeamOrbit'
import {
  DEFAULT_ITERATIONS,
  type GlobeDraft,
  type ProjectDraft,
  type StepDraft,
  emptyStep,
  initialProjectDraft,
  projectProblems,
  toCreateProjectInput,
} from '../components/creation/draft'
import { FRAGMENT_LABEL } from '../components/creation/kit'
import { GLOBE_TINTS } from '../components/creation/script'
import {
  ApiError,
  type CreateProjectInput,
  type CreationView,
  type FicheCreationView,
  api,
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { useVoix } from '../lib/voix'
import type { OscilloscopeInstance } from '../vendor/oscilloscope'
import { create as createOscilloscope } from '../vendor/oscilloscope'

const GLOBES_QUERY_KEY = ['globes'] as const
const PROJECTS_QUERY_KEY = ['projects'] as const
const CLIENTS_QUERY_KEY = ['clients'] as const
const ROLE_TEMPLATES_QUERY_KEY = ['role-templates'] as const

/** L'orbe de Hive au centre de la scène : config exacte du prototype. */
/**
 * Largeur maximale de la scène.
 *
 * Les fragments sont ancrés aux bords du cadre (`left: 32`, `right: 32`) :
 * sans plafond, ils suivent la fenêtre indéfiniment. Avec un plafond trop bas,
 * ils se collent à l'orbe et lui volent sa place — c'est ce que 1280 faisait
 * sur un écran de 2000, et c'est la correction demandée par Florian : « les
 * cards doivent se coller à l'extérieur, pour laisser le centre juste avec
 * l'orbe et Hive ».
 *
 * 2200 laisse les colonnes atteindre les bords d'un grand écran tout en
 * gardant une borne pour les très larges, où elles finiraient hors du champ
 * de vision.
 */
const LARGEUR_SCENE = 2200

/**
 * L'étape qui découvre le CTA. Dérivée de la fiche côté serveur
 * (`creation/fiche.ts::etapeFiche`) : un fragment se découvre parce qu'il a du
 * contenu, jamais parce qu'une horloge est arrivée au bout.
 */
const ETAPE_FINALE = 5

/** Le délai avant d'envoyer une correction manuelle. Une frappe ≠ une requête. */
const DELAI_CORRECTION = 700

const CREATION_QUERY_KEY = ['creation-en-cours'] as const

/**
 * La fiche de Hive vers le brouillon de l'écran.
 *
 * Deux vocabulaires : la fiche est le langage du serveur et de l'agent, le
 * brouillon celui des composants du pack, déjà écrits. Traduire aux deux
 * frontières coûte vingt lignes et évite de renommer des props dans cinq
 * composants pour un gain nul.
 */
function ficheVersBrouillon(fiche: FicheCreationView, base: ProjectDraft): ProjectDraft {
  const p = fiche.projet ?? {}
  const steps = fiche.steps ?? []
  return {
    ...base,
    name: p.nom ?? base.name,
    globe: p.orbe ?? base.globe,
    clientId: p.clientId ?? base.clientId,
    stack: p.stack ?? base.stack,
    repoFullName: p.depot ?? base.repoFullName,
    stagingUrl: p.staging ?? base.stagingUrl,
    jugeVisuel: p.jugeVisuel ?? base.jugeVisuel,
    demarrage: p.demarrage?.ou ?? base.demarrage,
    domaine: p.demarrage?.domaine ?? base.domaine,
    // Les steps de la fiche gagnent quand elle en porte : Hive a réécrit la
    // liste entière, pas un élément. Sinon on garde ceux de l'écran, qui
    // peuvent être des lignes vierges que personne n'a encore remplies.
    steps:
      steps.length > 0
        ? steps.map((st, i) => ({
            id: base.steps[i]?.id ?? `hive-${i}`,
            title: st.titre,
            specs: st.specs,
            auto: st.auto ?? false,
            iterations: st.iterations ?? DEFAULT_ITERATIONS,
          }))
        : base.steps,
  }
}

/** Le brouillon vers la fiche. Ce que l'écran affiche fait foi à la correction. */
function brouillonVersFiche(d: ProjectDraft, fiche: FicheCreationView): FicheCreationView {
  return {
    ...fiche,
    projet: {
      nom: d.name,
      orbe: d.globe,
      ...(d.clientId ? { clientId: d.clientId } : {}),
      stack: d.stack,
      depot: d.repoFullName,
      staging: d.stagingUrl,
      jugeVisuel: d.jugeVisuel,
      ...(d.demarrage !== ''
        ? {
            demarrage: {
              ou: d.demarrage,
              ...(d.domaine.trim() !== '' ? { domaine: d.domaine.trim() } : {}),
            },
          }
        : {}),
    },
    steps: d.steps
      .filter((st) => st.title.trim() !== '' || st.specs.trim() !== '')
      .map((st) => ({
        titre: st.title,
        specs: st.specs,
        auto: st.auto,
        iterations: st.iterations,
      })),
  }
}

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
 * Scène de Création : Hive arme une orbe et cadre un premier projet.
 *
 * ## Ce que cet écran a cessé d'être
 *
 * Il rejouait une conversation préscriptée. Cinq répliques tombaient sur des
 * `setTimeout` (300, 4200, 8200, 11400, 15000 ms), la fiche se remplissait par
 * un formulaire à droite, et les deux ne se parlaient pas. Un bouton
 * « ⟲ rejouer la conversation » rendait le théâtre explicite, et le champ de
 * saisie répondait « Hive ne traite pas encore la conversation ».
 *
 * Il y a maintenant un agent au bout. Florian écrit, Hive répond, challenge,
 * et remplit l'écran par `proposer_fiche` — un outil que le prompt du
 * majordome lui demandait déjà d'appeler et qui n'avait jamais existé.
 *
 * ## L'étape vient de la fiche, plus jamais d'une horloge
 *
 * `etape` est dérivée côté serveur (`creation/fiche.ts::etapeFiche`) de ce que
 * la fiche contient réellement. Un fragment se découvre parce qu'il a du
 * contenu. Un écran qui avance sur une minuterie ment dès que l'agent est plus
 * lent ou plus rapide que prévu — et un challenge avec recherche l'est.
 *
 * ## Le choix « Un projet / Un globe » a disparu
 *
 * C'étaient les deux boutons que Florian ne voulait plus. C'est la
 * conversation qui décide s'il faut une orbe neuve, et Hive la créera
 * lui-même. La scène n'a plus qu'un flux.
 *
 * ## Rien n'est perdu, jamais
 *
 * Le message humain est écrit en base AVANT l'appel au modèle : une panne ne
 * mange pas ce qui a été tapé. La conversation est persistée
 * (`creations`), donc un rafraîchissement la retrouve. Et les corrections
 * manuelles restent possibles sur chaque champ — l'échappatoire quand Hive n'a
 * pas compris le nom, remontée en différé pour qu'une frappe ne soit pas une
 * requête.
 *
 * ## Une panne se lit ici, pas dans les logs
 *
 * Modèle injoignable, budget à sec : la réplique centrale devient l'échec, en
 * couleur d'alerte, avec sa cause. La route rend 200 pour ça — un code
 * d'erreur afficherait un toast anonyme et perdrait la trace.
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

  const [hiveText, setHiveText] = useState('')
  /** Le fil complet, déployé par-dessus la scène. Replié par défaut. */
  const [filOuvert, setFilOuvert] = useState(false)
  /** Les conversations passées. Elles n'étaient relisibles que par `psql`. */
  const [archivesOuvertes, setArchivesOuvertes] = useState(false)
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

  /**
   * La conversation en cours. Ouverte à la volée si aucune n'existe : Florian
   * arrive sur l'écran et parle, il n'a pas à cliquer « commencer ».
   */
  const creationQuery = useQuery({
    queryKey: CREATION_QUERY_KEY,
    queryFn: async () => (await api.creations.enCours()) ?? (await api.creations.ouvrir()),
  })
  const creation = creationQuery.data ?? null

  const dire = useMutation({
    mutationFn: ({ id, texte }: { id: string; texte: string }) => api.creations.dire(id, texte),
    onSuccess: (suite) => queryClient.setQueryData(CREATION_QUERY_KEY, suite),
  })

  /**
   * La voix. La reconnaissance ÉCRIT dans le champ au lieu d'envoyer
   * directement : Florian relit avant d'envoyer, et corrige quand un nom
   * propre est passé de travers. C'est son échappatoire, pas une friction.
   */
  const voix = useVoix((dit) => setHiveText((prev) => (prev ? `${prev} ${dit}` : dit)))

  /**
   * Abandonner la conversation en cours et en ouvrir une neuve.
   *
   * Rien ne le permettait : la conversation reprend au chargement, et les
   * routes d'abandon existaient sans que l'écran ne les appelle. On restait
   * donc prisonnier de la dernière discussion, y compris une discussion de
   * test — constaté sur le serveur de production.
   */
  const recommencer = useMutation({
    mutationFn: async (id: string) => {
      await api.creations.abandonner(id)
      return api.creations.ouvrir()
    },
    onSuccess: (neuve) => {
      queryClient.setQueryData(CREATION_QUERY_KEY, neuve)
      setProject(initialProjectDraft(search.globe ?? ''))
      empreinteFiche.current = JSON.stringify(neuve.fiche)
      setFilOuvert(false)
    },
  })

  const archives = useQuery({
    queryKey: ['creations-toutes'],
    queryFn: api.creations.toutes,
    enabled: archivesOuvertes,
  })

  const reprendre = useMutation({
    mutationFn: (id: string) => api.creations.reprendre(id),
    onSuccess: (reprise) => {
      queryClient.setQueryData(CREATION_QUERY_KEY, reprise)
      void queryClient.invalidateQueries({ queryKey: ['creations-toutes'] })
      setProject((prev) => ficheVersBrouillon(reprise.fiche, prev))
      empreinteFiche.current = JSON.stringify(reprise.fiche)
      setArchivesOuvertes(false)
      setFilOuvert(false)
    },
  })

  const corriger = useMutation({
    mutationFn: ({ id, fiche }: { id: string; fiche: FicheCreationView }) =>
      api.creations.corriger(id, fiche),
    onSuccess: (suite) => queryClient.setQueryData(CREATION_QUERY_KEY, suite),
  })

  /**
   * Ce que Hive a rempli descend dans le brouillon affiché.
   *
   * Gardé par une empreinte : sans elle, chaque rendu réappliquerait la fiche
   * et écraserait une correction en cours de frappe. On ne redescend que
   * lorsque la fiche a réellement changé côté serveur.
   */
  const empreinteFiche = useRef('')
  useEffect(() => {
    if (!creation) return
    const empreinte = JSON.stringify(creation.fiche)
    if (empreinte === empreinteFiche.current) return
    empreinteFiche.current = empreinte
    setProject((prev) => ficheVersBrouillon(creation.fiche, prev))
  }, [creation])

  /**
   * Les corrections manuelles remontent, en différé.
   *
   * `corrige` n'est armé que par une saisie humaine (`touch`), jamais par la
   * descente ci-dessus : sans ce garde-fou, appliquer une fiche de Hive
   * déclencherait un PATCH qui la lui renverrait telle quelle, à chaque tour.
   */
  const corrige = useRef(false)
  const minuteurCorrection = useRef(0)
  useEffect(() => {
    if (!corrige.current || !creation) return
    corrige.current = false
    window.clearTimeout(minuteurCorrection.current)
    const fiche = brouillonVersFiche(project, creation.fiche)
    minuteurCorrection.current = window.setTimeout(() => {
      empreinteFiche.current = JSON.stringify(fiche)
      corriger.mutate({ id: creation.id, fiche })
    }, DELAI_CORRECTION)
  }, [project, creation, corriger.mutate])

  useEffect(() => () => window.clearTimeout(minuteurCorrection.current), [])

  const oscHostRef = useRef<HTMLDivElement>(null)
  const oscRef = useRef<OscilloscopeInstance | null>(null)
  /**
   * L'oscilloscope montre le tour EN VOL, pas une réplique qui tombe.
   *
   * Il jouait `speak` sur un minuteur de 2,3 s à chaque ligne scriptée : il
   * faisait semblant. Un challenge avec recherche prend quinze à trente
   * secondes, et sans ce signal on croit que c'est cassé.
   *
   * `listen` est laissé intact — il a été construit pour le micro, et le lot
   * vocal le prendra tel quel.
   */
  useEffect(() => {
    const osc = oscRef.current
    if (!osc) return
    // `listen` d'abord : quand le micro tourne, c'est ce qu'il faut montrer.
    // Cet état existait depuis l'origine et n'avait jamais été atteint.
    osc.setState(voix.ecoute ? 'listen' : dire.isPending ? 'speak' : 'idle')
  }, [dire.isPending, voix.ecoute])

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
    corrige.current = true
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

  /**
   * Ce que la scène affiche au centre : la dernière réplique de Hive, ou la
   * panne s'il vient d'en essuyer une. Plus aucune horloge n'intervient.
   */
  const dernierHive = [...(creation?.conversation ?? [])].reverse().find((t) => t.de === 'hive')
  const dernierHumain = [...(creation?.conversation ?? [])]
    .reverse()
    .find((t) => t.de === 'florian')
  const sceneText = dire.isPending
    ? 'Je regarde…'
    : (dernierHive?.texte ?? (creationQuery.isLoading ? '' : 'Hive ouvre la scène…'))
  const userLine = dernierHumain ? `${me.login} · « ${dernierHumain.texte} »` : ''

  /**
   * Hive parle. Les pannes aussi, et c'est le point : la règle est d'apprendre
   * un échec depuis l'écran où il se produit — mais quand on a délibérément
   * quitté l'écran pour travailler, une panne muette est pire que tout.
   *
   * Gardé par l'horodatage du tour : sans ça, chaque rendu relancerait la
   * lecture de la même phrase.
   */
  const dernierLu = useRef('')
  useEffect(() => {
    if (!dernierHive || dernierHive.a === dernierLu.current) return
    dernierLu.current = dernierHive.a
    voix.dire(dernierHive.texte)
  }, [dernierHive, voix.dire])

  const stage = creation?.etape ?? 0
  const isProjet = true
  const final = stage >= ETAPE_FINALE
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
    opacity: stage >= 1 ? 1 : 0,
    transform: `translateY(${stage >= 1 ? '0px' : '14px'})`,
    transition: 'opacity 600ms var(--ease), transform 600ms var(--ease-out)',
    pointerEvents: stage >= 1 ? 'auto' : 'none',
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
    pointerEvents: stage >= 2 ? 'auto' : 'none',
  }

  // Le fragment du bas apparaît quand la fiche porte un roster ou de la
  // mémoire (étape 4) : c'est ce qu'il raconte.
  const bottomShown = stage >= 4
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
          flexWrap: 'wrap',
          gap: '6px 20px',
          padding: '18px 24px 0',
          flexShrink: 0,
          zIndex: 7,
          // Même gabarit que la scène, sinon « Fermer » part au bord de
          // l'écran pendant que la fiche reste centrée.
          width: '100%',
          maxWidth: LARGEUR_SCENE,
          alignSelf: 'center',
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
            {'Création · orbe et projet'}
          </span>
          <span
            style={{
              font: '11.5px var(--font-mono)',
              color: 'var(--text-low)',
            }}
          >
            la fiche se matérialise autour de la conversation
          </span>
        </div>
        {/*
          Nommé pour ce qu'il fait. Il s'appelait « Annuler » et n'annulait
          rien : il navigue, et le brouillon survit — ce qui est le bon
          comportement, mais pas ce que le mot promettait.
        */}
        <Link to="/globes" style={{ font: '500 12px var(--font-sans)', color: 'var(--text-low)' }}>
          Fermer
        </Link>
      </header>

      {/* La scène est PLAFONNÉE en largeur, et c'est la correction d'un vrai
          défaut : les fragments sont ancrés aux bords de ce cadre (`left: 32`,
          `right: 32`). Tant qu'il faisait toute la largeur de la fenêtre, plus
          l'écran était large, plus la fiche s'écartait de l'orbe — sur un
          1920, on regardait le centre, on y voyait une orbe et une question,
          et les panneaux étaient si loin qu'ils passaient pour absents.
          Constaté sur l'instance en ligne, reproduit ici à 1920 × 1080. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          width: '100%',
          maxWidth: LARGEUR_SCENE,
          alignSelf: 'center',
        }}
      >
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
              // Dérivée de la fenêtre, plus d'un chiffre fixe. Les colonnes
              // occupent 316 à gauche et 372 à droite, plus leurs marges : ce
              // qui reste au centre dépend de la largeur réelle. Un chiffre
              // fixe chevauchait les fragments sur un écran étroit, ou laissait
              // la réplique riquiqui sur un grand.
              // 890, mesuré et pas calculé : le texte est centré sur la SCÈNE, pas sur
              // l'espace libre entre les colonnes, et la barre latérale décale
              // le tout d'une trentaine de pixels vers la droite. Mesuré à
              // 1280 : avec 800 elle mordait de 34 px, avec 860 encore de 4 px.
              // Le calcul théorique disait deux fois qu'elle passait.
              maxWidth: 'min(620px, calc(100vw - 890px))',
              minWidth: 320,
              padding: '0 20px',
              textAlign: 'center',
              fontSize: 19,
              fontWeight: 500,
              lineHeight: 1.6,
              // Une panne se lit à l'endroit où irait la réplique, pas dans un
              // toast qui disparaît ni dans les logs du serveur.
              color: dernierHive?.panne ? 'var(--sem-alert)' : 'var(--text-hi)',
              textWrap: 'pretty',
              minHeight: 62,
              // Une réplique longue défile DANS sa zone au lieu de pousser la
              // saisie hors de l'écran. Hive a pour consigne de rester court,
              // mais une consigne de prompt ne tient pas une mise en page :
              // le jour où il déborde, la scène doit rester utilisable.
              maxHeight: 260,
              overflowY: 'auto',
              pointerEvents: 'auto',
            }}
          >
            {sceneText}
          </div>

          <div
            style={{
              width: 420,
              height: 52,
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
            }}
          >
            <input
              className="hive-input"
              value={hiveText}
              onChange={(e) => setHiveText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const said = hiveText.trim()
                if (said === '' || !creation || dire.isPending) return
                // Vidé tout de suite : ce que Florian a tapé est déjà écrit en
                // base par le serveur avant l'appel au modèle, il ne peut pas
                // être perdu par ce vidage.
                setHiveText('')
                dire.mutate({ id: creation.id, texte: said })
              }}
              type="text"
              placeholder="parlez à Hive…"
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

            {/*
              Le micro n'apparaît QUE si la reconnaissance locale est
              disponible. Pas d'API, pas de mode local, ou pack de langue
              absent : pas de bouton — plutôt qu'une bascule silencieuse vers
              la reconnaissance serveur, qui expédierait la voix de Florian
              chez un tiers pendant qu'il décrit le projet d'un client.
            */}
            {voix.disponible === true && (
              <button
                type="button"
                onClick={() => (voix.ecoute ? voix.arreterEcoute() : voix.demarrerEcoute())}
                className="creation-ghost"
                aria-label={voix.ecoute ? 'Arrêter la dictée' : 'Dicter'}
                aria-pressed={voix.ecoute}
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 'var(--r-full)',
                  border: `1px solid ${voix.ecoute ? 'var(--accent)' : 'var(--line-strong)'}`,
                  background: voix.ecoute ? 'var(--accent)' : 'rgba(9, 14, 22, 0.6)',
                  color: voix.ecoute ? 'var(--accent-ink)' : 'var(--text-hi)',
                  cursor: 'pointer',
                  font: '15px var(--font-sans)',
                }}
              >
                ●
              </button>
            )}

            {/*
              Le choix de la voix, là où on l'entend. Un réglage rangé dans un
              autre écran se règle une fois et jamais plus ; celui-ci se change
              en écoutant, ce qui est le seul moyen de trancher entre deux
              voix. N'apparaît que quand il y a un choix à faire.
            */}
            {!voix.muet && voix.voix.length > 1 && (
              <select
                className="creation-field"
                value={voix.voixChoisie ?? ''}
                onChange={(e) => voix.choisirVoix(e.target.value || null)}
                aria-label="Voix de Hive"
                title="La voix qui lit les réponses"
                style={{
                  background: 'rgba(9, 14, 22, 0.6)',
                  border: '1px solid var(--line-strong)',
                  borderRadius: 'var(--r-full)',
                  padding: '11px 14px',
                  font: '500 12px var(--font-mono)',
                  color: 'var(--text-mid)',
                  outline: 'none',
                  maxWidth: 150,
                }}
              >
                <option value="">{voix.voix[0]?.name ?? 'voix système'}</option>
                {voix.voix.slice(1).map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={voix.basculerMuet}
              className="creation-ghost"
              aria-label={voix.muet ? 'Réactiver la lecture à voix haute' : 'Couper la voix'}
              aria-pressed={voix.muet}
              title={voix.muet ? 'Hive ne parle pas' : 'Hive lit ses réponses'}
              style={{
                width: 42,
                height: 42,
                borderRadius: 'var(--r-full)',
                border: '1px solid var(--line-strong)',
                background: 'rgba(9, 14, 22, 0.6)',
                color: voix.muet ? 'var(--text-low)' : 'var(--text-hi)',
                cursor: 'pointer',
                font: '15px var(--font-sans)',
              }}
            >
              {voix.muet ? '🔇' : '🔊'}
            </button>
          </div>

          {/*
            Ce que la voix a à dire d'elle-même. Un micro refusé ou un pack en
            cours de téléchargement doit se lire ici : sans ça, un bouton qui
            ne répond pas est indiscernable d'un bouton cassé.
          */}
          {(voix.panne || voix.installation) && (
            <span
              style={{
                font: '11.5px var(--font-mono)',
                color: voix.panne ? 'var(--sem-alert)' : 'var(--text-low)',
              }}
            >
              {voix.panne ?? 'téléchargement du pack de langue français…'}
            </span>
          )}
        </div>

        {
          <IdentityCard
            style={fragment1}
            mode="projet"
            project={project}
            globe={globe}
            globes={globes}
            clients={clientsQuery.data ?? []}
            onProject={patchProject}
            onGlobe={patchGlobe}
          />
        }

        {
          <StepsColumn
            style={fragment2}
            revealed={stage >= 2}
            steps={project.steps}
            onPatch={patchStep}
            onAdd={addStep}
            onRemove={removeStep}
          />
        }
        <InfraPanel style={fragment4} draft={project} onPatch={patchProject} />

        {
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
              {pending ? 'Création…' : 'Créer le projet'}
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
        }

        {archivesOuvertes && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 64,
              transform: 'translateX(-50%)',
              zIndex: 8,
              width: 'min(560px, calc(100% - 64px))',
              maxHeight: '52%',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 18,
              borderRadius: 'var(--r-lg)',
              border: '1px solid var(--line-strong)',
              background: 'var(--bg-0)',
              backdropFilter: 'blur(12px)',
              boxShadow: '0 18px 48px rgba(0, 0, 0, 0.55)',
              pointerEvents: 'auto',
            }}
          >
            <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
              conversations passées
            </span>
            {(archives.data ?? []).length === 0 && (
              <span style={{ font: '12px var(--font-sans)', color: 'var(--text-low)' }}>
                {archives.isLoading ? 'chargement…' : 'aucune autre conversation'}
              </span>
            )}
            {(archives.data ?? []).map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => reprendre.mutate(a.id)}
                disabled={reprendre.isPending || a.statut === 'en_cours'}
                className="creation-ghost"
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 12,
                  textAlign: 'left',
                  padding: '9px 11px',
                  borderRadius: 'var(--r-md)',
                  border: '1px solid var(--line)',
                  background: 'transparent',
                  cursor: a.statut === 'en_cours' ? 'default' : 'pointer',
                  color: 'var(--text-hi)',
                  font: '13px var(--font-sans)',
                }}
              >
                <span style={{ textWrap: 'pretty' }}>{a.nom ?? 'sans nom'}</span>
                <span
                  style={{
                    font: '10.5px var(--font-mono)',
                    color: 'var(--text-low)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {a.statut === 'en_cours' ? 'en cours' : a.statut} · {a.tours} tours
                  {/*
                    Le compte de savoirs dit ce qu'on perd de vue : ils ne sont
                    PAS en mémoire tant que le projet n'est pas créé.
                  */}
                  {a.savoirs > 0 ? ` · ${a.savoirs} savoir(s) en brouillon` : ''}
                </span>
              </button>
            ))}
          </div>
        )}

        {filOuvert && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 64,
              transform: 'translateX(-50%)',
              zIndex: 8,
              width: 'min(560px, calc(100% - 64px))',
              maxHeight: '52%',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: 18,
              borderRadius: 'var(--r-lg)',
              border: '1px solid var(--line-strong)',
              // Opaque, et pas seulement sombre : à 0.94 la réplique centrale
              // transparaissait à travers le fil et les deux textes se
              // superposaient. Le flou couvre ce que l'opacité laisse passer.
              background: 'var(--bg-0)',
              backdropFilter: 'blur(12px)',
              boxShadow: '0 18px 48px rgba(0, 0, 0, 0.55)',
              pointerEvents: 'auto',
            }}
            // Le dernier tour est le plus utile : on ouvre sur la fin du fil,
            // pas sur son début.
            ref={(n) => {
              if (n) n.scrollTop = n.scrollHeight
            }}
          >
            {(creation?.conversation ?? []).map((tour) => (
              <div
                key={`${tour.a}-${tour.de}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  alignItems: tour.de === 'florian' ? 'flex-end' : 'flex-start',
                }}
              >
                <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
                  {tour.de === 'florian' ? me.login : 'Hive'}
                </span>
                <span
                  style={{
                    font: '13.5px var(--font-sans)',
                    lineHeight: 1.55,
                    textAlign: tour.de === 'florian' ? 'right' : 'left',
                    color: tour.panne ? 'var(--sem-alert)' : 'var(--text-hi)',
                    textWrap: 'pretty',
                  }}
                >
                  {tour.texte}
                </span>
              </div>
            ))}
          </div>
        )}

        {creation && (creation.conversation.length > 1 || creation.etape > 0) && (
          <button
            type="button"
            onClick={() => recommencer.mutate(creation.id)}
            disabled={recommencer.isPending}
            className="creation-ghost"
            style={{
              position: 'absolute',
              // À DROITE, avec les deux autres commandes. Le coin bas-gauche
              // est occupé par le panneau d'infra : les trois se recouvraient,
              // et le bouton du dessus gagnait au clic.
              right: 340,
              bottom: 24,
              zIndex: 7,
              background: 'transparent',
              border: 'none',
              cursor: recommencer.isPending ? 'default' : 'pointer',
              font: '500 11px var(--font-mono)',
              color: 'var(--text-low)',
              padding: 4,
            }}
          >
            {recommencer.isPending ? 'on repart…' : '⟲ repartir de zéro'}
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            setArchivesOuvertes((v) => !v)
            setFilOuvert(false)
          }}
          className="creation-ghost"
          style={{
            position: 'absolute',
            right: 168,
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
          {archivesOuvertes ? 'fermer ⌄' : 'conversations passées ⌃'}
        </button>

        <button
          type="button"
          onClick={() => {
            setFilOuvert((v) => !v)
            setArchivesOuvertes(false)
          }}
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
          {filOuvert
            ? 'replier le fil ⌄'
            : `déployer le fil (${creation?.conversation.length ?? 0}) ⌃`}
        </button>
      </div>
    </div>
  )
}

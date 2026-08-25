import type { InboxStatus, InboxType } from '@silithid/shared'
import type {
  InboxItemView,
  InboxResponsePayload,
  OptimizeAnswerResult,
  ResolveResult,
} from './inbox-types'
import type { ProjectView, RunView, StepView } from './project-types'

/**
 * Un champ refusé par la validation du serveur : `POST /api/projects` rend
 * `400 { error, details }` où `details` sont les `issues` zod telles quelles
 * (`{ path, message }`). L'écran de création doit pouvoir dire QUEL champ ne
 * va pas — d'où ce transport jusqu'à l'UI plutôt qu'un « ça n'a pas marché ».
 */
export interface ApiErrorDetail {
  /** Chemin du champ fautif, aplati : `name`, `steps.1.specs`… */
  path: string
  message: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: ApiErrorDetail[] = [],
    /**
     * Le corps d'erreur brut. Certains refus portent une donnée exploitable
     * que `error`/`details` n'ont pas de place pour transporter : le 409 de
     * `POST /api/steps/:id/start` rend le `runId` du run qui occupe déjà le
     * step, et sans lui l'écran ne pourrait qu'afficher une erreur là où il
     * doit proposer d'ouvrir la boucle en cours.
     */
    readonly payload: unknown = null,
  ) {
    super(message)
  }
}

/** Les `issues` zod sont du JSON non typé : on ne garde que ce qui est lisible. */
function toDetails(raw: unknown): ApiErrorDetail[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): ApiErrorDetail[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const issue = entry as { path?: unknown; message?: unknown }
    if (typeof issue.message !== 'string' || issue.message.length === 0) return []
    const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : ''
    return [{ path, message: issue.message }]
  })
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // `exactOptionalPropertyTypes` interdit d'assigner `undefined` à `headers`/`body`
  // (RequestInit ne les type pas avec `| undefined`) : on omet les clés au lieu de
  // les mettre à `undefined` quand il n'y a pas de corps.
  const res = await fetch(path, {
    method,
    credentials: 'include',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  })
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown }
    throw new ApiError(
      res.status,
      payload.error ?? `HTTP ${res.status}`,
      toDetails(payload.details),
      payload,
    )
  }
  return (await res.json()) as T
}

export interface Me {
  id: string
  login: string
}

/**
 * Sous-ensemble de `ProjectView` (project-types.ts) dont l'Inbox a besoin :
 * le nom et la teinte du projet pour la ligne de méta d'un item (« Le Koin ·
 * dev · q-112 »). `api.projects.list()` rend la forme complète — le reste des
 * champs (step, loop, conso…) est simplement ignoré ici, pas absent.
 */
export interface ProjectSummary {
  id: string
  name: string
  tint: string | null
}

/**
 * Miroir front de `GlobeView` (apps/server/src/globes/repo.ts). Comme pour
 * les projets, `id` est le slug public. Les compteurs (`projectCount`,
 * `activeCount`, `pendingCount`) sont dérivés côté serveur — jamais
 * recalculés ici.
 */
export interface BudgetGauge {
  /** Pourcentage retenu pour décider : le max des deux fenêtres, majoration comprise. */
  pct: number
  /** `false` quand la mesure est périmée : la jauge s'affiche « inconnu ». */
  known: boolean
  fiveHourPct: number
  sevenDayPct: number
  ageMinutes: number | null
}

export interface BudgetView {
  /** `null` quand le runtime n'expose aucune consommation : afficher « inconnu », jamais un zéro rassurant. */
  gauge: BudgetGauge | null
  reason: string
  resetsAt: string | null
  reserve: { state: 'intacte' | 'entamee'; pct: number; until: string | null }
  thresholds: { pause: number; pauseNominal: number; resume: number }
}

// --- Types des écrans restants (journal, analytics, run en direct, coffre) ---

export interface JournalNightEntry {
  id: string
  at: string
  role: string
  toRole: string
  kind: string
  text: string
  projectId: string | null
  projectName: string | null
  runId: string
}

export interface JournalDecisionEntry {
  id: string
  at: string
  kind: string
  subtype: string | null
  title: string
  response: unknown
  projectId: string | null
  projectName: string | null
  /** Toujours `false` : révoquer suppose de savoir DÉFAIRE chaque type de décision. */
  revocable: false
}

export interface JournalView {
  window: { since: string; until: string }
  retentionDays: number
  night: JournalNightEntry[]
  decisions: JournalDecisionEntry[]
}

export interface AnalyticsView {
  days: number
  totalTokens: number
  totalEur: number
  daily: { day: string; tokens: number }[]
  perProject: {
    id: string
    name: string
    tint: string | null
    tokens: number
    eur: number
    stepsDone: number
  }[]
}

export interface StepCostView {
  position: number
  title: string
  tokens: number
  eur: number
}

export interface RunTimelineEntry {
  id: string
  fromRole: string
  toRole: string
  kind: string
  body: string
  meta: Record<string, unknown>
  at: string
}

export interface RunDetailView {
  id: string
  project: { id: string; name: string }
  step: { position: number; title: string }
  state: string
  resumeState: string | null
  iteration: [number, number]
  reviewRound: number
  branch: string | null
  prNumber: number | null
  costTokens: number
  startedAt: string
  endedAt: string | null
  /** `null` tant que le run tourne : c'est au front d'animer depuis `startedAt`. */
  durationSeconds: number | null
  timeline: RunTimelineEntry[]
  artifacts: { id: string; kind: string; path: string; meta: unknown; at: string }[]
}

export interface VaultEntryView {
  key: string
}

/**
 * Miroir front de `SavoirARevoir` (apps/server/src/knowledge/review.ts).
 *
 * Tout y est déjà calculé côté serveur — le libellé du cercle, l'âge, la
 * raison de la proposition. L'écran n'a rien à dériver : une seconde règle de
 * tri ou une seconde façon de dire « jamais rappelé » divergerait de celle qui
 * a réellement classé la file.
 */
export interface SavoirRevueView {
  racineId: string
  version: number
  cercle: 'projet' | 'client' | 'globe' | 'hive'
  /** « fiche client Bastide », « mémoire du globe Desura », « conscience de Hive ». */
  cercleLabel: string
  sujet: string
  contenu: string
  /** Score d'utilité mesuré par le rappel réel. 0 = jamais servi à un agent. */
  rappels: number
  ageJours: number
  createdAt: string
  /** Dernière confirmation humaine, `null` si le savoir n'est jamais passé en revue. */
  revueAt: string | null
  pourquoi: string
}

export interface RevueSavoirsView {
  /** Durée pendant laquelle un savoir confirmé reste hors de la file (90 j). */
  periodeJours: number
  actifs: number
  /** Total à revoir · peut dépasser `items.length`, la file étant plafonnée. */
  aRevoir: number
  /** Phrase de Hive, calculée depuis ces mêmes nombres · aucun appel de modèle. */
  hive: string
  items: SavoirRevueView[]
}

export interface HiveMessageView {
  id: string
  from: string
  body: string
  at: string
}

export interface StartedRun {
  runId: string
  stepId: string
  position: number
  title: string
}

export interface GlobeView {
  id: string
  name: string
  color: string | null
  position: number
  projectCount: number
  activeCount: number
  pendingCount: number
}

export interface CreateGlobeInput {
  name: string
  color?: string
}

/**
 * Un step à la création (`POST /api/projects`). `specs` est obligatoire côté
 * serveur : un step sans specs serait un step qu'aucun agent ne peut prendre.
 * `autonomy` ne porte QUE sur l'itération dev↔reviewer — la mise en prod reste
 * un gate quelle que soit sa valeur.
 */
export interface CreateProjectStepInput {
  title: string
  specs: string
  autonomy?: 'gated' | 'auto'
  maxIterations?: number
}

/**
 * Corps de `POST /api/projects`. `globe` est le slug du globe d'accueil, et
 * `repoFullName` (`owner/nom`) désigne un dépôt qui doit **déjà exister** :
 * le serveur enregistre un projet, il ne crée aucun dépôt.
 */
export interface CreateProjectInput {
  globe: string
  name: string
  repoFullName: string
  clientId?: string
  stack?: string
  tint?: string
  stagingUrl?: string
  steps?: CreateProjectStepInput[]
}

export interface CreatedProject {
  id: string
  slug: string
  name: string
  globeSlug: string
  stepCount: number
}

/**
 * Sous-ensemble de `ClientView` (apps/server/src/clients/repo.ts) dont l'écran
 * de création a besoin : de quoi remplir un menu déroulant. `id` est l'UUID de
 * la fiche — c'est lui que `POST /api/projects` attend en `clientId`. Même
 * parti que `ProjectSummary` : les autres champs sont ignorés, pas absents.
 */
export interface ClientSummary {
  id: string
  name: string
}

/** Miroir front de `RoleTemplateView` (apps/server/src/api/routes/roles.ts). */
export interface RoleTemplateView {
  key: string
  projectType: string
  version: number
  model: string | null
  usedByProjects: number
  /** Toujours `null` : la table n'a aucune colonne d'horodatage (cf. serveur). */
  modifiedAt: null
}

/**
 * Miroir front de `ClientView` (apps/server/src/clients/repo.ts) : la fiche
 * complète rendue par `GET /api/clients`.
 *
 * Deux absences sont volontaires côté serveur et se lisent ici :
 * `accessKeys` ne porte que les NOMS des accès (aucune valeur de secret ne
 * sort de l'API), et `knowledge` n'a ni version ni score de rappel — rien de
 * tout cela n'est mesuré, l'écran doit le dire plutôt que d'afficher un « v1 »
 * et un compteur à zéro.
 */
export interface ClientKnowledgeView {
  question: string
  answer: string
  /** Item d'inbox d'où vient la réponse, quand il est connu. */
  sourceItemId: string | null
  at: string | null
}

export interface ClientContactView {
  name: string | null
  role: string | null
  email: string | null
  phone: string | null
}

export interface ClientView {
  id: string
  name: string
  siret: string | null
  /** Ton attendu, injecté dans le cadrage de chaque step (loop/steps/framing.ts). */
  tone: string | null
  contacts: ClientContactView[]
  knowledge: ClientKnowledgeView[]
  /** Noms des accès détenus dans le coffre. **Jamais les valeurs.** */
  accessKeys: string[]
  /** Projets rattachés : `id` est le slug public. */
  projects: { id: string; name: string }[]
}

export interface InboxListFilters {
  status?: InboxStatus
  type?: InboxType
  project?: string
}

function toQuery(filters: InboxListFilters): string {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.type) params.set('type', filters.type)
  if (filters.project) params.set('project', filters.project)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/** Résultat de `GET /api/health/auth` (`AuthHealthcheckResult`, health/auth-check.ts). */
export interface AuthHealthView {
  ok: boolean
  /** Présent seulement en échec : la cause telle que le runtime l'a rendue. */
  error?: string
}

/** Un serveur, tel que `GET /api/serveurs` le rend. Aucune valeur de secret n'y figure. */
export interface ServeurView {
  id: string
  nom: string
  hote: string
  utilisateur: string
  port: number
  url: string | null
  /** `inconnu` tant que la sonde n'est pas passée : aucune autonomie sans mesure. */
  etat: 'inconnu' | 'vierge' | 'en_service'
  mesureAt: string | null
  notes: string | null
  /** Un booléen, jamais la valeur — même règle que l'inventaire du coffre. */
  accesDepose: boolean
  cleCoffre: string | null
}

export interface PreuveSondeView {
  nom: string
  verdict: 'occupe' | 'vide' | 'inconnu'
  detail: string
}

export interface ResultatSondeView {
  etat: 'inconnu' | 'vierge' | 'en_service'
  raison: string
  preuves: PreuveSondeView[]
  /** `true` quand la mesure a été ignorée : un serveur en service ne redevient jamais vierge. */
  figee: boolean
}

/** `GET /api/savoirs/apercu` (`knowledge/apercu.ts`). Aucun contenu de savoir n'y figure. */
export interface ApercuMemoireView {
  cercles: {
    cercle: 'projet' | 'client' | 'globe' | 'hive'
    actifs: number
    /** `null` pour `hive`, qui est unique : la question de l'instance ne se pose pas. */
    instances: number | null
    rappels: number
  }[]
  actifs: number
  versions: number
  jamaisRappeles: number
  plusUtile: { sujet: string; cercle: string; rappels: number } | null
  emprunts: { actifs: number; lecture: number; fork: number }
  stack: { code: number; exploitation: number }
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  login: (login: string, password: string) =>
    request<Me>('POST', '/api/auth/login', { login, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  inbox: {
    list: (filters: InboxListFilters = {}) =>
      request<InboxItemView[]>('GET', `/api/inbox${toQuery(filters)}`),
    resolve: (id: string, response: InboxResponsePayload) =>
      request<ResolveResult>('POST', `/api/inbox/${id}/resolve`, { response }),
    /** À la demande uniquement (bouton « Optimiser ») — jamais appelé à la frappe. */
    optimize: (id: string, text: string) =>
      request<OptimizeAnswerResult>('POST', `/api/inbox/${id}/optimize`, { text }),
  },
  serveurs: {
    list: () => request<ServeurView[]>('GET', '/api/serveurs'),
    /**
     * Enregistre un serveur. Aucun état n'est envoyé : il naît « inconnu », et
     * il n'existe volontairement AUCUNE route pour en poser un — « vierge » se
     * mesure, un formulaire qui permettrait de le déclarer contournerait la
     * sonde en un clic.
     */
    create: (body: {
      nom: string
      hote: string
      utilisateur: string
      port?: number
      url?: string
      notes?: string
    }) => request<{ id: string; nom: string; etat: string }>('POST', '/api/serveurs', body),
    /** Mesure. Un geste qui touche le serveur, donc explicitement demandé. */
    sonde: (id: string) =>
      request<ResultatSondeView>('POST', `/api/serveurs/${encodeURIComponent(id)}/sonde`),
  },
  projects: {
    list: () => request<ProjectView[]>('GET', '/api/projects'),
    /**
     * Projets d'un seul globe (écran « intérieur de globe »). Signature
     * distincte de `list()` plutôt qu'un paramètre optionnel : `list` est
     * passée telle quelle en `queryFn` par Dashboard et CommandPalette, et
     * React Query appelle `queryFn(context)` — un paramètre de filtre y
     * recevrait le contexte de la requête, pas un filtre.
     *
     * Le filtrage est fait par le serveur (`?globe=`) : un globe peut porter
     * 100+ projets, les charger tous pour en jeter la majorité serait payer
     * la liste complète à chaque entrée dans un globe.
     */
    byGlobe: (globe: string) =>
      request<ProjectView[]>('GET', `/api/projects?globe=${encodeURIComponent(globe)}`),
    get: (id: string) => request<ProjectView>('GET', `/api/projects/${encodeURIComponent(id)}`),
    steps: (id: string) =>
      request<StepView[]>('GET', `/api/projects/${encodeURIComponent(id)}/steps`),
    runs: (id: string) => request<RunView[]>('GET', `/api/projects/${encodeURIComponent(id)}/runs`),
    /**
     * Fait rédiger au communicant un brouillon d'email client, à la demande.
     *
     * On envoie le SUJET, pas le texte : le communicant va lire la fiche
     * client, en applique le ton et évite de redemander ce qui a déjà été
     * répondu. Dicter le contenu en ferait un correcteur orthographique.
     *
     * Un vrai échange modèle par appel, donc jamais déclenché autrement que
     * par un clic explicite — même règle que `inbox.optimize`.
     */
    communicant: (id: string, sujet: string) =>
      request<{ inboxItemId: string | null; raison?: string }>(
        'POST',
        `/api/projects/${encodeURIComponent(id)}/communicant`,
        { sujet },
      ),
    /**
     * Crée un projet et ses steps · rien d'autre. Aucun dépôt GitHub n'est
     * créé, aucun staging n'est provisionné, aucun accès n'est déposé dans le
     * coffre (cf. `apps/server/src/projects/create.ts`) : l'écran de création
     * ne doit rien promettre de plus.
     */
    create: (input: CreateProjectInput) => request<CreatedProject>('POST', '/api/projects', input),
  },
  clients: {
    /**
     * La fiche complète, pas un résumé : `ClientView` contient `ClientSummary`
     * (l'écran de création n'y lit toujours que `id`/`name`), et l'écran
     * Clients a besoin du reste — la route rend déjà tout.
     */
    list: () => request<ClientView[]>('GET', '/api/clients'),
  },
  roleTemplates: {
    list: () => request<RoleTemplateView[]>('GET', '/api/role-templates'),
  },
  budget: {
    /**
     * La mesure est gratuite côté serveur (`runtime/usage.ts` interroge le SDK
     * sans consommer de token) : cette route peut être rafraîchie sans coût.
     */
    get: () => request<BudgetView>('GET', '/api/budget'),
  },
  globes: {
    list: () => request<GlobeView[]>('GET', '/api/globes'),
    create: (input: CreateGlobeInput) => request<GlobeView>('POST', '/api/globes', input),
  },
  journal: {
    /** `hours` est borné côté serveur par la rétention annoncée (90 j). */
    get: (hours?: number) =>
      request<JournalView>('GET', `/api/journal${hours ? `?hours=${hours}` : ''}`),
  },
  analytics: {
    get: (days?: number) =>
      request<AnalyticsView>('GET', `/api/analytics${days ? `?days=${days}` : ''}`),
    steps: (projectId: string) =>
      request<StepCostView[]>('GET', `/api/analytics/steps/${encodeURIComponent(projectId)}`),
  },
  savoirs: {
    /** L'état réel de la mémoire · des comptes, jamais du contenu en vrac. */
    apercu: () => request<ApercuMemoireView>('GET', '/api/savoirs/apercu'),
    /**
     * La file de la revue de péremption. Gratuite : un `select` trié et une
     * phrase calculée, jamais un échange avec un modèle — l'écran peut donc
     * être ouvert et rafraîchi sans coût.
     */
    revue: () => request<RevueSavoirsView>('GET', '/api/savoirs/revue'),
    /** « Toujours vrai · garder » : date la confirmation, ne touche pas au score d'utilité. */
    garder: (racineId: string) =>
      request<{ racineId: string; revueAt: string }>(
        'POST',
        `/api/savoirs/${encodeURIComponent(racineId)}/garder`,
      ),
    /** « Plus d'actualité · archiver » : hors du rappel, historique conservé. */
    archiver: (racineId: string) =>
      request<{ racineId: string; archive: true }>(
        'POST',
        `/api/savoirs/${encodeURIComponent(racineId)}/archiver`,
      ),
  },
  vault: {
    /** Inventaire seul : aucune valeur de secret ne transite jamais par l'API. */
    list: () => request<VaultEntryView[]>('GET', '/api/vault'),
  },
  hive: {
    messages: () => request<HiveMessageView[]>('GET', '/api/hive/messages'),
    /**
     * Un tour de conversation. Coûte des tokens : à n'appeler que sur envoi
     * explicite, jamais à la frappe.
     */
    ask: (text: string) =>
      request<{ reply: HiveMessageView; costTokens: number }>('POST', '/api/hive/messages', {
        text,
      }),
  },
  runs: {
    get: (id: string) => request<RunDetailView>('GET', `/api/runs/${encodeURIComponent(id)}`),
    /** Démarre la boucle sur un step. 409 si un run occupe déjà ce step. */
    start: (stepId: string) =>
      request<StartedRun>('POST', `/api/steps/${encodeURIComponent(stepId)}/start`),
    pause: (id: string) =>
      request<{ id: string; state: string }>('POST', `/api/runs/${encodeURIComponent(id)}/pause`),
    resume: (id: string) =>
      request<{ id: string; state: string }>('POST', `/api/runs/${encodeURIComponent(id)}/resume`),
    stop: (id: string, reason?: string) =>
      request<{ id: string; state: string }>(
        'POST',
        `/api/runs/${encodeURIComponent(id)}/stop`,
        reason ? { reason } : undefined,
      ),
    /**
     * Écrit une consigne dans le bus. Elle n'est PAS lue par la session en
     * cours : les handlers lisent le bus au démarrage de leur invocation. Le
     * geste utile est pause · consigne · reprise.
     */
    instruct: (id: string, role: string, text: string) =>
      // Le champ attendu par la route s'appelle `body` (`instructBody`, zod,
      // apps/server/src/api/routes/runs.ts) : envoyer `text` valait un
      // `400 corps_invalide` à chaque consigne. `readAt` est rendu par le
      // serveur en toutes lettres pour que l'écran puisse dire QUAND elle sera
      // lue — il est affiché tel quel, jamais reformulé.
      request<{ id: string; role: string; state: string; readAt: string }>(
        'POST',
        `/api/runs/${encodeURIComponent(id)}/instruct`,
        { role, body: text },
      ),
  },
  settings: {
    /** Tous les réglages, valeurs scellées remplacées par `***` (store.listPublic). */
    list: () => request<Record<string, unknown>>('GET', '/api/settings'),
    /**
     * Écrit un réglage public. Les secrets passent par le même endpoint avec
     * `secret: true` — l'écran Réglages ne s'en sert pas : on n'envoie pas un
     * secret depuis un champ de formulaire pour l'afficher ensuite en `***`.
     */
    set: (key: string, value: unknown) =>
      request<{ ok: true }>('PUT', '/api/settings', { key, value }),
  },
  health: {
    /**
     * Ouvre réellement une session agent (`adapter.healthcheck()`) : c'est le
     * seul signal fiable d'une authentification valide, et c'est aussi une
     * invocation payante. À la demande uniquement, jamais en rafraîchissement
     * automatique. En échec, le serveur lève une alerte inbox + un email.
     */
    auth: () => request<AuthHealthView>('GET', '/api/health/auth'),
  },
}

import type { SettingsStore } from '../settings/store'

/**
 * Gmail, en deux surfaces qui ne se touchent pas (Task 5, Phase 5).
 *
 * Le contrat de la phase : « le communicant rédige, il n'envoie pas ». Ce
 * fichier existe pour que cette phrase soit vraie au niveau de la
 * configuration, pas seulement dans le prompt du rôle. Deux fois déjà ce
 * projet a cru une frontière posée alors qu'elle ne l'était pas : `bash:
 * false` traduit en `allowedTools` n'empêchait rien (Phase 1), et sans
 * `strictMcpConfig: true` les agents voyaient les connecteurs MCP de l'hôte
 * (Phase 2, cf. la note de tête de `runtime/tools.ts`). Un prompt qui dit
 * « n'envoie pas » est de la même famille : une consigne, pas une frontière.
 *
 * D'où la séparation en deux ports distincts, sans porte d'entrée commune :
 *
 * - `GmailDraftPort` : la seule surface jamais exposée à un agent. Une seule
 *   opération, `createDraft`. Il n'y a pas de méthode d'envoi à appeler, ni de
 *   drapeau à passer pour en obtenir une.
 * - `GmailSendPort` : action serveur. Sa signature exige une
 *   `HumanSendApproval`, que seule `HumanSendApproval.fromResolvedInboxItem`
 *   sait construire, à partir d'un item d'inbox réellement résolu et
 *   réellement approuvé par un humain. La classe porte un champ privé : aucun
 *   objet littéral n'est assignable à sa place (typage nominal), et son
 *   constructeur est privé. Détenir le port ne suffit donc pas à envoyer.
 *
 * Précision qui compte pour le câblage réel : côté Google, **aucun scope OAuth
 * ne dit « brouillon seulement »**. `gmail.compose` couvre la création de
 * brouillon ET l'envoi ; `gmail.send` couvre l'envoi. Il est donc impossible
 * de faire porter la restriction par le jeton : c'est exactement pour ça
 * qu'elle est portée ici, par la forme des deux ports, et par le fait que
 * l'agent ne reçoit jamais que `drafts`.
 *
 * Aucun identifiant n'est câblé dans ce fichier ni ailleurs dans le dépôt :
 * tant que le coffre est vide, `createGmailAccount` rend un compte factice en
 * mémoire (mode `dry-run`), sur le même principe que `MAIL_DRY_RUN` dans
 * `mailer.ts`. `mailer.ts` reste réservé aux alertes système : un email client
 * doit partir du Gmail de Florian, avec son historique de conversation et sa
 * signature, pas d'un SMTP anonyme.
 */

/** Contenu d'un email client, tel qu'il partira. */
export interface EmailDraft {
  /** Destinataire principal, une seule adresse. */
  to: string
  cc?: string[]
  subject: string
  /** Corps en texte brut. */
  body: string
}

export interface GmailDraftRef {
  draftId: string
  threadId?: string
}

export interface GmailSentRef {
  messageId: string
  threadId?: string
}

/**
 * Surface joignable par un agent. Une seule opération, et elle ne fait rien
 * partir. Ajouter ici une méthode d'envoi serait le geste exact que cette
 * séparation existe pour rendre visible.
 */
export interface GmailDraftPort {
  createDraft(draft: EmailDraft): Promise<GmailDraftRef>
}

/** Ce qu'on relit d'un item d'inbox pour décider si un envoi est autorisé. */
export interface ResolvedApprovalEvidence {
  id: string
  type: string
  subtype: string | null
  status: string
  humanResponse: Record<string, unknown> | null
  payload: Record<string, unknown>
}

/**
 * Preuve qu'un humain a validé cet envoi précis.
 *
 * Constructeur privé et champ privé : hors de ce module, on ne peut ni
 * l'instancier, ni fabriquer un objet littéral qui lui soit assignable (le
 * champ privé rend le type nominal). La seule voie est
 * `fromResolvedInboxItem`, qui refuse tout ce qui n'est pas un item
 * `approval`/`email` déjà résolu avec une réponse humaine `approved: true`.
 */
export class HumanSendApproval {
  private constructor(
    readonly inboxItemId: string,
    readonly draftId: string,
    private readonly approvedAt: Date,
  ) {}

  /** Horodatage de la validation, tracé au moment de l'envoi. */
  approvedAtIso(): string {
    return this.approvedAt.toISOString()
  }

  static fromResolvedInboxItem(evidence: ResolvedApprovalEvidence): HumanSendApproval {
    if (evidence.type !== 'approval' || evidence.subtype !== 'email') {
      throw new Error(
        `item ${evidence.id} : envoi refusé, ce n'est pas une approbation d'email (${evidence.type}/${evidence.subtype ?? 'sans sous-type'})`,
      )
    }
    if (evidence.status !== 'done') {
      throw new Error(
        `item ${evidence.id} : envoi refusé, item non résolu (statut ${evidence.status})`,
      )
    }
    if (evidence.humanResponse?.approved !== true) {
      throw new Error(`item ${evidence.id} : envoi refusé, aucune approbation humaine explicite`)
    }
    const draftId = evidence.payload.draftId
    if (typeof draftId !== 'string' || draftId.length === 0) {
      throw new Error(`item ${evidence.id} : envoi refusé, aucun brouillon rattaché`)
    }
    return new HumanSendApproval(evidence.id, draftId, new Date())
  }
}

/**
 * Action serveur. Exige la preuve de validation : détenir ce port ne donne
 * pas le pouvoir d'envoyer, il faut en plus un item d'inbox approuvé.
 */
export interface GmailSendPort {
  sendDraft(approval: HumanSendApproval): Promise<GmailSentRef>
}

export type GmailMode = 'dry-run' | 'live'

export interface GmailAccount {
  mode: GmailMode
  /** À ne remettre qu'à ce qui rédige. */
  drafts: GmailDraftPort
  /** À ne remettre qu'au chemin serveur post-validation. */
  sender: GmailSendPort
}

/**
 * Nom du serveur MCP que la politique d'outils du communicant déclare
 * (`src/db/seed.ts`). Le nom lui-même est une décision : le serveur n'expose
 * que le brouillon, donc il s'appelle `gmail_draft` et pas `gmail`.
 */
export const GMAIL_DRAFT_MCP_SERVER = 'gmail_draft'

/**
 * Refuse toute entrée MCP Gmail autre que `gmail_draft`.
 *
 * Sans ce garde-fou, ajouter `gmail_send` à la liste `mcp` d'un rôle ne
 * casserait rien de visible : `resolveToolPolicy` traduirait sagement l'entrée
 * en `mcp__gmail_send` et le jour où un serveur de ce nom existerait, un agent
 * aurait l'envoi. Appelé sur le chemin de construction de la surface d'outils
 * du communicant, donc impossible à contourner en modifiant seulement la
 * graine.
 */
export function assertDraftOnlyGmailPolicy(mcp: readonly string[]): void {
  const offenders = mcp.filter((n) => n.includes('gmail') && n !== GMAIL_DRAFT_MCP_SERVER)
  if (offenders.length > 0) {
    throw new Error(
      `politique d'outils refusée : un agent ne peut recevoir que « ${GMAIL_DRAFT_MCP_SERVER} » côté Gmail, jamais ${offenders.join(', ')}`,
    )
  }
}

/** Compte factice en mémoire : aucun réseau, rien ne part. */
export interface FakeGmailAccount extends GmailAccount {
  mode: 'dry-run'
  /** Brouillons créés, dans l'ordre. */
  readonly drafted: readonly (EmailDraft & GmailDraftRef)[]
  /** Envois effectués, avec l'item d'inbox qui les a autorisés. */
  readonly sent: readonly { draftId: string; inboxItemId: string }[]
}

export function createFakeGmailAccount(): FakeGmailAccount {
  const drafted: (EmailDraft & GmailDraftRef)[] = []
  const sent: { draftId: string; inboxItemId: string }[] = []
  let counter = 0

  return {
    mode: 'dry-run',
    drafted,
    sent,
    drafts: {
      async createDraft(draft) {
        counter += 1
        const ref: GmailDraftRef = { draftId: `draft-${counter}`, threadId: `thread-${counter}` }
        drafted.push({ ...draft, ...ref })
        console.log(`[GMAIL_DRY_RUN] brouillon à=${draft.to} objet="${draft.subject}"`)
        return ref
      },
    },
    sender: {
      async sendDraft(approval) {
        const draft = drafted.find((d) => d.draftId === approval.draftId)
        if (!draft) throw new Error(`brouillon inconnu : ${approval.draftId}`)
        // Deux validations d'un même item ne doivent pas produire deux emails
        // chez le client : le vrai Gmail refuse déjà un `drafts.send` sur un
        // brouillon consommé, le factice refuse de la même façon.
        if (sent.some((s) => s.draftId === approval.draftId)) {
          throw new Error(`brouillon déjà envoyé : ${approval.draftId}`)
        }
        sent.push({ draftId: approval.draftId, inboxItemId: approval.inboxItemId })
        console.log(`[GMAIL_DRY_RUN] envoi du brouillon ${approval.draftId}`)
        return {
          messageId: `message-${approval.draftId}`,
          ...(draft.threadId ? { threadId: draft.threadId } : {}),
        }
      },
    },
  }
}

/** Sous-ensemble de `fetch` réellement utilisé, pour pouvoir l'injecter en test. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface GmailHttpConfig {
  /** Adresse expéditrice, en en-tête `From`. */
  from: string
  /** Rend un jeton d'accès OAuth2 valide au moment de l'appel. */
  accessToken: () => Promise<string>
  /** Boîte visée. `me` = celle du jeton. */
  userId?: string
  fetchImpl?: FetchLike
}

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users'

/**
 * Encode un en-tête non ASCII en « encoded-word » (RFC 2047). Un objet en
 * français sans ça arrive avec les accents cassés chez le client.
 */
function encodeHeaderValue(value: string): string {
  const ascii = [...value].every((c) => {
    const code = c.charCodeAt(0)
    return code >= 32 && code < 127
  })
  if (ascii) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/**
 * Message RFC 2822 complet. Corps en base64 : le texte est en UTF-8 et peut
 * contenir des lignes longues, deux choses que le 7 bits brut ne garantit pas.
 * Fonction pure, donc vérifiable sans réseau ni compte.
 */
export function buildMimeMessage(draft: EmailDraft, from: string): string {
  const headers = [
    `From: ${from}`,
    `To: ${draft.to}`,
    ...(draft.cc && draft.cc.length > 0 ? [`Cc: ${draft.cc.join(', ')}`] : []),
    `Subject: ${encodeHeaderValue(draft.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ]
  const body = Buffer.from(draft.body, 'utf8').toString('base64')
  const wrapped = (body.match(/.{1,76}/g) ?? []).join('\r\n')
  return `${headers.join('\r\n')}\r\n\r\n${wrapped}`
}

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/**
 * Implémentation HTTP de l'API Gmail (v1), sans dépendance ajoutée : `fetch`
 * suffit, et le projet n'installe pas `googleapis` pour trois appels.
 *
 * **Jamais exercée contre le vrai Gmail à ce jour** (aucun compte configuré,
 * voir la note de tête). Les tests couvrent les requêtes émises, pas les
 * réponses de Google. C'est un chemin à valider par un premier envoi manuel
 * avant de s'y fier.
 */
export function createGmailHttpAccount(config: GmailHttpConfig): GmailAccount {
  const userId = config.userId ?? 'me'
  const doFetch: FetchLike = config.fetchImpl ?? ((url, init) => fetch(url, init))

  async function post(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const token = await config.accessToken()
    const res = await doFetch(`${GMAIL_API}/${encodeURIComponent(userId)}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Gmail ${path} a répondu ${res.status} : ${text}`)
    return JSON.parse(text) as Record<string, unknown>
  }

  return {
    mode: 'live',
    drafts: {
      async createDraft(draft) {
        const raw = toBase64Url(buildMimeMessage(draft, config.from))
        const body = await post('drafts', { message: { raw } })
        const draftId = body.id
        if (typeof draftId !== 'string') {
          throw new Error(`Gmail drafts n'a pas renvoyé d'identifiant : ${JSON.stringify(body)}`)
        }
        const message = body.message as { threadId?: unknown } | undefined
        return {
          draftId,
          ...(typeof message?.threadId === 'string' ? { threadId: message.threadId } : {}),
        }
      },
    },
    sender: {
      async sendDraft(approval) {
        const body = await post('drafts/send', { id: approval.draftId })
        const messageId = body.id
        if (typeof messageId !== 'string') {
          throw new Error(
            `Gmail drafts/send n'a pas renvoyé d'identifiant : ${JSON.stringify(body)}`,
          )
        }
        return {
          messageId,
          ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
        }
      },
    },
  }
}

export interface RefreshTokenConfig {
  clientId: string
  clientSecret: string
  refreshToken: string
  fetchImpl?: FetchLike
}

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * Échange le jeton de rafraîchissement contre un jeton d'accès, et le garde
 * en mémoire jusqu'à 60 s avant son expiration. Rien n'est écrit sur disque :
 * le seul secret durable vit dans le coffre (libsodium), comme les accès de
 * déploiement.
 */
export function createAccessTokenProvider(config: RefreshTokenConfig): () => Promise<string> {
  const doFetch: FetchLike = config.fetchImpl ?? ((url, init) => fetch(url, init))
  let cached: { token: string; expiresAt: number } | null = null

  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.token

    const res = await doFetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`rafraîchissement du jeton Gmail refusé (${res.status}) : ${text}`)

    const body = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown }
    if (typeof body.access_token !== 'string') {
      throw new Error('réponse OAuth sans access_token — jeton de rafraîchissement révoqué ?')
    }
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 3600
    cached = { token: body.access_token, expiresAt: Date.now() + (ttl - 60) * 1000 }
    return cached.token
  }
}

/** Clés du coffre attendues pour un compte réel. Aucune n'a de valeur par défaut. */
export const GMAIL_SECRET_KEYS = {
  clientId: 'gmail.oauth.client_id',
  clientSecret: 'gmail.oauth.client_secret',
  refreshToken: 'gmail.oauth.refresh_token',
  from: 'gmail.from',
} as const

/**
 * Construit le compte à partir du coffre.
 *
 * Trois cas, distingués honnêtement plutôt que confondus : coffre vide ⇒ mode
 * `dry-run` (rien ne part, tout est en mémoire) ; coffre complet ⇒ compte
 * réel ; coffre à moitié rempli ⇒ erreur. Le dernier cas mérite l'erreur :
 * retomber silencieusement en `dry-run` sur une configuration partielle
 * ferait disparaître des emails clients validés par un humain, sans que
 * personne ne s'en aperçoive.
 */
export async function createGmailAccount(settings: SettingsStore): Promise<GmailAccount> {
  const entries = await Promise.all(
    Object.entries(GMAIL_SECRET_KEYS).map(
      async ([name, key]) => [name, await settings.getSecret(key)] as const,
    ),
  )
  const present = entries.filter(([, value]) => value !== undefined && value !== '')

  if (present.length === 0) return createFakeGmailAccount()

  if (present.length !== entries.length) {
    const missing = entries
      .filter(([, value]) => value === undefined || value === '')
      .map(([name]) => GMAIL_SECRET_KEYS[name as keyof typeof GMAIL_SECRET_KEYS])
    throw new Error(`configuration Gmail incomplète, secrets manquants : ${missing.join(', ')}`)
  }

  const values = Object.fromEntries(entries) as Record<keyof typeof GMAIL_SECRET_KEYS, string>

  return createGmailHttpAccount({
    from: values.from,
    accessToken: createAccessTokenProvider({
      clientId: values.clientId,
      clientSecret: values.clientSecret,
      refreshToken: values.refreshToken,
    }),
  })
}

/**
 * Port d'envoi qui ne lit le coffre qu'au premier envoi réel.
 *
 * Construire le compte au démarrage ferait dépendre le boot du serveur de
 * l'état du schéma (la table `settings` doit exister) : les tests construisent
 * l'application avant de migrer, et un déploiement qui redémarre avant sa
 * migration tomberait sur la même pierre. Le compte est mémorisé après la
 * première résolution, pour ne pas perdre le cache de jeton OAuth.
 */
export function createLazyGmailSender(settings: SettingsStore): GmailSendPort {
  let account: Promise<GmailAccount> | null = null
  return {
    async sendDraft(approval) {
      account ??= createGmailAccount(settings)
      return (await account).sender.sendDraft(approval)
    },
  }
}

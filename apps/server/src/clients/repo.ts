import type { Kysely } from 'kysely'
import type { Database } from '../db/types'

/**
 * Les fiches clients (`Clients.dc.html`).
 *
 * ## Ce que cette route expose, et ce qu'elle n'exposera jamais
 *
 * La table `clients` porte une colonne `secrets` (jsonb, chiffrée
 * applicativement). **Aucune valeur de secret ne sort d'ici.** Seuls les NOMS
 * des accès enregistrés sont renvoyés, pour que l'écran puisse afficher « SSH
 * · dans le coffre » sans que le mot de passe transite par le réseau, par un
 * cache de navigateur ou par un journal de requêtes. Le pack DA le prévoit
 * ainsi : la section « Accès » liste ce qui existe, elle ne le révèle pas.
 *
 * ## L'écart assumé avec le pack
 *
 * Le prototype affiche une base de connaissances où chaque entrée est
 * **versionnée** (`v1`, `v2`…), **révocable** pendant 30 jours, restaurable, et
 * porte un **score d'utilité** (« × 12 rappels », ou « jamais rappelée » en
 * ambre). Rien de tout cela n'est stockable aujourd'hui : la colonne `notes`
 * ne contient que `{q, a, source_item_id, at}`.
 *
 * On rend donc les entrées telles qu'elles existent, sans inventer un `v1` ni
 * un compteur à zéro qui laisserait croire que le savoir n'a jamais servi
 * alors qu'on ne le mesure pas. Versions, révocation et rappels appartiennent
 * à la conscience collective, qui a sa propre phase.
 */

/** Une question résolue en inbox, devenue un fait sur le client. */
export interface ClientKnowledge {
  question: string
  answer: string
  /** Item d'inbox d'où vient la réponse, quand il est connu : la traçabilité fait partie du savoir. */
  sourceItemId: string | null
  at: string | null
}

export interface ClientContact {
  name: string | null
  role: string | null
  email: string | null
  phone: string | null
}

export interface ClientView {
  id: string
  name: string
  siret: string | null
  /** Le ton fait foi pour le communicant : c'est la fiche qui décide, jamais son habitude. */
  tone: string | null
  contacts: ClientContact[]
  knowledge: ClientKnowledge[]
  /** Noms des accès détenus dans le coffre. **Jamais les valeurs.** */
  accessKeys: string[]
  /** Projets rattachés, par slug et nom : c'est ainsi que l'écran les lie. */
  projects: { id: string; name: string }[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * `contacts` et `notes` sont du jsonb : leur forme n'est garantie par personne.
 * Une fiche mal remplie ne doit pas faire tomber la page — elle doit afficher
 * ce qui est lisible et taire le reste.
 */
function parseContacts(raw: unknown): ClientContact[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const c = asRecord(entry)
    return {
      name: str(c.name),
      role: str(c.role),
      email: str(c.email),
      phone: str(c.phone),
    }
  })
}

function parseKnowledge(raw: unknown): ClientKnowledge[] {
  if (!Array.isArray(raw)) return []
  const out: ClientKnowledge[] = []
  for (const entry of raw) {
    const n = asRecord(entry)
    const question = str(n.q)
    const answer = str(n.a)
    // Une note sans question ni réponse n'est pas un savoir : on ne l'affiche
    // pas plutôt que de rendre une ligne vide.
    if (!question || !answer) continue
    out.push({
      question,
      answer,
      sourceItemId: str(n.source_item_id),
      at: str(n.at),
    })
  }
  return out
}

/** Les NOMS des accès, jamais leurs valeurs. Voir la note de tête. */
function parseAccessKeys(raw: unknown): string[] {
  return Object.keys(asRecord(raw)).sort()
}

export async function listClients(db: Kysely<Database>): Promise<ClientView[]> {
  const rows = await db.selectFrom('clients').selectAll().orderBy('name', 'asc').execute()
  const projects = await db
    .selectFrom('projects')
    .select(['client_id as clientId', 'slug as slug', 'name as name'])
    .orderBy('created_at', 'asc')
    .execute()

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    siret: row.siret,
    tone: row.tone,
    contacts: parseContacts(row.contacts),
    knowledge: parseKnowledge(row.notes),
    accessKeys: parseAccessKeys(row.secrets),
    projects: projects
      .filter((p) => p.clientId === row.id)
      .map((p) => ({ id: p.slug, name: p.name })),
  }))
}

export async function getClient(db: Kysely<Database>, id: string): Promise<ClientView | null> {
  const all = await listClients(db)
  return all.find((c) => c.id === id) ?? null
}

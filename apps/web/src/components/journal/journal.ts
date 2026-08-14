import { INBOX_TYPES, type InboxType } from '@silithid/shared'
import { SEM, TAG } from '../inbox/constants'

/**
 * Rôles émetteurs des passations (`messages.from_role`, clés `ROLE_KEYS` de
 * `@silithid/shared`) tels que le pack les affiche : libellé et couleur de la
 * pastille (`Component.RC` de `Journal.dc.html`).
 *
 * `majordome` s'affiche « Hive » — « l'agent orchestrateur s'appelle HIVE
 * (ex-Majordome), toutes les UI disent Hive » (`docs/design/CLAUDE.md`).
 * `judge` s'affiche « Juge », comme dans `TEAM_ROLES` (creation/script.ts).
 */
const ROLES: Record<string, { label: string; color: string }> = {
  majordome: { label: 'Hive', color: 'var(--accent)' },
  garant: { label: 'Garant', color: 'oklch(0.82 0.06 235)' },
  dev: { label: 'Dev', color: 'var(--accent)' },
  reviewer: { label: 'Reviewer', color: 'var(--sem-question)' },
  judge: { label: 'Juge', color: 'var(--sem-verdict)' },
  communicant: { label: 'Communicant', color: 'var(--ok)' },
}

/** Un rôle inconnu garde sa clé brute et la couleur neutre : jamais renommé au hasard. */
export function roleLabel(role: string): string {
  return ROLES[role]?.label ?? role
}

export function roleColor(role: string): string {
  return ROLES[role]?.color ?? 'var(--pause)'
}

function isInboxType(kind: string): kind is InboxType {
  return (INBOX_TYPES as readonly string[]).includes(kind)
}

/** Étiquette d'une décision : « VALIDATION · EMAIL », « QUESTION »… (même vocabulaire que l'Inbox). */
export function decisionTag(kind: string, subtype: string | null): string {
  const base = isInboxType(kind) ? TAG[kind] : kind.toUpperCase()
  return subtype ? `${base} · ${subtype.toUpperCase()}` : base
}

export function decisionColor(kind: string): string {
  return isInboxType(kind) ? SEM[kind] : 'var(--pause)'
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

/** Clé de regroupement par journée locale (pas UTC : c'est la journée de Florian). */
export function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** « Aujourd'hui · mer. 12 août », « Hier · mar. 11 août », sinon la date seule. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const date = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long' })
  const yesterday = new Date(now.getTime() - 86_400_000)
  if (dayKey(iso) === dayKey(now.toISOString())) return `Aujourd'hui · ${date}`
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return `Hier · ${date}`
  return date
}

/** « du 12 août 22:04 au 13 août 09:12 » — la fenêtre réellement rendue par le serveur. */
export function windowLabel(since: string, until: string): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('fr-FR', {
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    })
  return `du ${fmt(since)} au ${fmt(until)}`
}

/**
 * Ce que l'humain a répondu, rendu lisible. `human_response` est du JSON de
 * forme libre (`resolve.ts` accepte n'importe quel objet) : on ne rend que ce
 * qu'on sait nommer, et rien du tout sinon — jamais un `[object Object]` ni
 * un JSON brut jeté dans une ligne de journal.
 */
export function describeResponse(response: unknown): string | null {
  if (typeof response === 'string') return response.trim() || null
  if (typeof response !== 'object' || response === null) return null
  const r = response as Record<string, unknown>
  const parts: string[] = []
  if (r.approved === true) parts.push('validé')
  if (r.approved === false) parts.push('refusé')
  if (r.verdict === 'accepted') parts.push('step validé')
  if (r.verdict === 'iterate') parts.push('relancé avec correctifs')
  if (typeof r.action === 'string' && r.action) parts.push(r.action)
  if (typeof r.maxIterations === 'number') parts.push(`max_iterations → ${r.maxIterations}`)
  if (typeof r.text === 'string' && r.text.trim()) parts.push(r.text.trim())
  return parts.length > 0 ? parts.join(' · ') : null
}

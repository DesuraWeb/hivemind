/**
 * `age`/`ageMin` ne sont jamais rendus par l'API (Task 4/7 : « la Phase 1 a
 * séparé blocked_since de created_at précisément pour ça ») — ils se
 * périment dès que l'horloge tourne. Ce module les calcule côté front à
 * partir de `blockedSince` (items bloquants) / `createdAt` (les autres),
 * dans le même format que `INBOX[].age` de data.js (« il y a 26 min »).
 */
export function ageMinutes(iso: string, now: Date = new Date()): number {
  const ms = now.getTime() - new Date(iso).getTime()
  return Math.max(0, Math.round(ms / 60_000))
}

export function formatAge(iso: string, now: Date = new Date()): string {
  const min = ageMinutes(iso, now)
  if (min < 1) return "à l'instant"
  if (min < 60) return `il y a ${min} min`
  const hours = Math.round(min / 60)
  if (hours < 24) return `il y a ${hours} h`
  const days = Math.round(hours / 24)
  return `il y a ${days} j`
}

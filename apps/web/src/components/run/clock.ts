import { useEffect, useState } from 'react'

/** « 04:12 », « 1:02:37 » — le chrono du pack, en tabular-nums. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * Le chrono d'un run.
 *
 * `GET /api/runs/:id` rend `durationSeconds: null` tant que le run tourne, et
 * s'en explique : figer une durée à l'instant de la requête afficherait un
 * chrono mort qui ne bougerait qu'au prochain rafraîchissement. C'est donc au
 * front d'animer, depuis `startedAt` — un `setInterval` d'une seconde, arrêté
 * dès que le run est terminé (`durationSeconds` renseigné), et jamais un appel
 * réseau de plus.
 *
 * Le temps mesuré est le temps écoulé depuis le démarrage, pas le temps de
 * travail des agents : il continue de courir pendant une pause. C'est ce que
 * le serveur calcule pour un run terminé (`ended_at - started_at`), et les
 * deux doivent donner le même nombre.
 */
export function useRunClock(startedAt: string, durationSeconds: number | null): string {
  const [seconds, setSeconds] = useState(() =>
    durationSeconds !== null
      ? durationSeconds
      : (Date.now() - new Date(startedAt).getTime()) / 1000,
  )

  useEffect(() => {
    if (durationSeconds !== null) {
      setSeconds(durationSeconds)
      return
    }
    const started = new Date(startedAt).getTime()
    const tick = () => setSeconds((Date.now() - started) / 1000)
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [startedAt, durationSeconds])

  return formatClock(seconds)
}

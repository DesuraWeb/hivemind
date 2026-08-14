import { useEffect, useState } from 'react'

/**
 * Le curseur s'efface après un temps d'immobilité, et revient au premier
 * mouvement (`Ambient.dc.html`, `this._move` / `cursor: none`). C'est le seul
 * écran qui le fait : il est prévu pour rester affiché sur un téléviseur,
 * une flèche figée au milieu de l'orbe y resterait des heures.
 *
 * Le rappel « esc · retour au dashboard » suit le même état : visible tant
 * qu'une main est sur la souris, effacé avec le curseur.
 */
export function useIdleCursor(delayMs = 3500): boolean {
  const [idle, setIdle] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const wake = () => {
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), delayMs)
    }
    window.addEventListener('mousemove', wake)
    wake()
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mousemove', wake)
    }
  }, [delayMs])

  return idle
}

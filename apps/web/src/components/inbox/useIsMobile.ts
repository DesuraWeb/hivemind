import { useEffect, useState } from 'react'

/**
 * Sous cette largeur, l'Inbox passe en triage tactile : une seule colonne et
 * un bottom-sheet à la place du panneau latéral (`docs/design/Inbox
 * mobile.dc.html`).
 *
 * 720px et non 390 (la largeur du cadre iPhone du prototype) : le point de
 * bascule n'est pas la taille d'un téléphone, c'est le moment où la liste
 * (360px au minimum) et le panneau de traitement ne tiennent plus côte à
 * côte. Le rail nav mange 60px de plus, d'où la marge.
 */
export const MOBILE_QUERY = '(max-width: 720px)'

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches)
    setMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return mobile
}

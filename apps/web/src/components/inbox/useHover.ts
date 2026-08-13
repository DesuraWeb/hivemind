import { useState } from 'react'

/**
 * Les prototypes .dc.html expriment le hover via `style-hover` (sucre de leur
 * runtime, pas du CSS standard) sur un élément dont toutes les autres
 * propriétés sont déjà inline. Une règle `:hover` en feuille de style externe
 * ne pourrait pas gagner contre un `background`/`border` déjà posé en style
 * inline (spécificité) : on reproduit donc le hover en state React plutôt
 * qu'en CSS, ce qui garantit le même rendu quelle que soit la propriété
 * concernée.
 */
export function useHover(): [boolean, { onMouseEnter: () => void; onMouseLeave: () => void }] {
  const [hover, setHover] = useState(false)
  return [hover, { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) }]
}

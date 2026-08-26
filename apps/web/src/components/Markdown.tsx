import type { CSSProperties, ReactNode } from 'react'

/**
 * Un rendu markdown BORNÉ, sans dépendance.
 *
 * ## Pourquoi il existe
 *
 * `steps.specs` et `savoirs.contenu` sont déclarés `md` depuis la toute
 * première migration. Le markdown était l'intention depuis le début, et
 * personne ne l'a jamais rendu : les écrans affichaient la chaîne brute, d'où
 * des specs illisibles en un seul pavé — « les steps c'est moche, on comprend
 * rien » (Florian, en regardant son premier vrai projet).
 *
 * ## Pourquoi pas une bibliothèque
 *
 * Chaque dépendance est de la maintenance et une surface d'attaque. Les
 * bibliothèques markdown rendent du HTML, ce qui demande soit
 * `dangerouslySetInnerHTML` soit une passe d'assainissement — pour du texte
 * écrit par un AGENT, donc influençable par ce qu'il a lu sur le web.
 *
 * Ici rien n'est interprété comme du HTML : on construit des nœuds React. Une
 * balise dans le texte s'affiche comme du texte, par construction et pas par
 * filtrage.
 *
 * ## Ce qu'il couvre, et rien de plus
 *
 * Titres `##` et `###`, listes à puces, `**gras**`, `` `code` ``, paragraphes.
 * C'est ce que le brief demande aux agents d'écrire. Un sous-ensemble borné
 * qu'on lit en entier vaut mieux qu'un rendu complet dont personne ne connaît
 * les recoins.
 */

const CODE: CSSProperties = {
  font: '0.92em var(--font-mono)',
  background: 'color-mix(in oklab, var(--text-low) 14%, transparent)',
  borderRadius: 4,
  padding: '1px 5px',
}

/** `**gras**` et `` `code` ``. Découpage par jetons, jamais par HTML. */
function inline(texte: string, cle: string): ReactNode[] {
  const noeuds: ReactNode[] = []
  const motif = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let dernier = 0
  let n = 0
  for (const m of texte.matchAll(motif)) {
    const i = m.index ?? 0
    if (i > dernier) noeuds.push(texte.slice(dernier, i))
    const jeton = m[0]
    n += 1
    if (jeton.startsWith('**')) {
      noeuds.push(
        <strong key={`${cle}-g${n}`} style={{ color: 'var(--text-hi)', fontWeight: 600 }}>
          {jeton.slice(2, -2)}
        </strong>,
      )
    } else {
      noeuds.push(
        <code key={`${cle}-c${n}`} style={CODE}>
          {jeton.slice(1, -1)}
        </code>,
      )
    }
    dernier = i + jeton.length
  }
  if (dernier < texte.length) noeuds.push(texte.slice(dernier))
  return noeuds
}

export function Markdown({ texte, style }: { texte: string; style?: CSSProperties }) {
  const lignes = texte.split('\n')
  const blocs: ReactNode[] = []
  let puces: string[] = []
  let paragraphe: string[] = []

  const viderPuces = () => {
    if (puces.length === 0) return
    const items = [...puces]
    puces = []
    blocs.push(
      <ul
        key={`u${blocs.length}`}
        style={{ margin: '2px 0 0', paddingLeft: 18, display: 'grid', gap: 4 }}
      >
        {items.map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: le texte d'une puce peut se répéter à l'identique dans une même liste
          <li key={i} style={{ lineHeight: 1.6 }}>
            {inline(it, `u${blocs.length}-${i}`)}
          </li>
        ))}
      </ul>,
    )
  }

  const viderParagraphe = () => {
    if (paragraphe.length === 0) return
    const t = paragraphe.join(' ')
    paragraphe = []
    blocs.push(
      <p key={`p${blocs.length}`} style={{ margin: 0, lineHeight: 1.65 }}>
        {inline(t, `p${blocs.length}`)}
      </p>,
    )
  }

  for (const brute of lignes) {
    const l = brute.trim()

    if (l === '') {
      viderPuces()
      viderParagraphe()
      continue
    }

    const titre = /^(#{2,3})\s+(.*)$/.exec(l)
    if (titre) {
      viderPuces()
      viderParagraphe()
      blocs.push(
        <span
          key={`h${blocs.length}`}
          style={{
            font: '600 10px var(--font-sans)',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-mid)',
            marginTop: blocs.length > 0 ? 6 : 0,
          }}
        >
          {titre[2]}
        </span>,
      )
      continue
    }

    const puce = /^[-*·]\s+(.*)$/.exec(l)
    if (puce) {
      viderParagraphe()
      puces.push(puce[1] ?? '')
      continue
    }

    viderPuces()
    paragraphe.push(l)
  }
  viderPuces()
  viderParagraphe()

  return <div style={{ display: 'grid', gap: 8, ...style }}>{blocs}</div>
}

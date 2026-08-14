import type { ProjectView } from '../../lib/project-types'

const IDLE_TITLE = "Silithid · vue d'ensemble"
const IDLE_LINE = "Toutes les boucles sous les yeux · l'orbe respire avec le système."

export interface AmbientFocusLineProps {
  /** Le projet actuellement mis en avant par le cycle · `null` pendant la respiration. */
  project: ProjectView | null
}

/**
 * Le commentaire du coin bas gauche (`Ambient.dc.html`) : le nom du projet en
 * focus, sa ligne d'état, puis la synthèse de Hive.
 *
 * Le prototype porte une table `LINES` de phrases écrites à la main par
 * projet (« Le dev travaille la recherche · itération 2/4 »). Elle n'est pas
 * reprise : ce sont des textes de fixture, et en inventer l'équivalent
 * raconterait l'état d'une boucle sans l'avoir lu. Ce qui s'affiche vient de
 * `line` (calculé par le serveur) et de `synth` (la prose de Hive quand elle
 * existe) — rien d'autre.
 */
export function AmbientFocusLine({ project }: AmbientFocusLineProps) {
  const title = project ? `${project.name} · ${project.line}` : IDLE_TITLE
  const detail = project ? project.synth : IDLE_LINE

  return (
    <div
      style={{
        position: 'absolute',
        left: 40,
        bottom: 34,
        zIndex: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        pointerEvents: 'none',
        maxWidth: 460,
      }}
    >
      <span
        style={{
          font: '600 10px var(--font-mono)',
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: project?.tint ?? 'var(--text-low)',
          transition: 'color var(--dur-3) var(--ease)',
        }}
      >
        {title}
      </span>
      {detail && (
        <span
          style={{
            font: '500 15px var(--font-sans)',
            color: 'var(--text-mid)',
            lineHeight: 1.5,
            textWrap: 'pretty',
          }}
        >
          {detail}
        </span>
      )}
    </div>
  )
}

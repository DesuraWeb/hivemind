import { Note, SectionTitle, formatTokensShort } from './kit'

/**
 * Les barres quotidiennes (`Analytics.dc.html`, `Component.DAILY`).
 *
 * La série arrive **sans trou** du serveur : un point par jour de la fenêtre,
 * même à zéro (`analytics/repo.ts`, `emptyDays`). C'est délibéré, et l'écran
 * doit le respecter — sinon les barres se resserreraient sur les jours actifs
 * et un week-end creux disparaîtrait au lieu de se voir. Un jour à zéro se
 * dessine donc, en gris, à 2 px : une trace, pas un trou.
 *
 * ## Échelle
 *
 * Linéaire, sur le pic de la fenêtre — comme le prototype. Une échelle
 * logarithmique rendrait les petits jours plus jolis mais mentirait sur les
 * proportions, ce qui est exactement ce qu'on demande à cet écran de ne pas
 * faire.
 *
 * Quand un seul jour porte tout le volume, les autres tombent à leur plancher
 * (voir `FLOOR_ACTIVE`) : ils restent visibles, et distincts d'un jour vide
 * qui est plus bas ET gris. Le pic est chiffré sous l'axe, et chaque barre
 * porte sa valeur en infobulle native — la donnée exacte reste atteignable
 * sans faire mentir le dessin.
 */

const W = 700
const H = 120
const GAP = 4
/** Hauteur utile : 120 − 8 px de respiration sous le sommet, comme le prototype. */
const USABLE = 112
/**
 * Deux planchers, et c'est ce qui rend la série lisible quand un seul jour
 * porte tout le volume : un jour vide fait 2 px de gris, un jour actif jamais
 * moins de 5 px de cyan. Les deux ne se confondent donc jamais, même écrasés
 * par un pic 40 fois plus haut. La hauteur reste linéaire au-dessus du
 * plancher — on ne triche pas sur les proportions, on garantit seulement
 * qu'« il s'est passé quelque chose » ne disparaisse pas.
 */
const FLOOR_EMPTY = 2
const FLOOR_ACTIVE = 5

export interface DailyBarsProps {
  daily: { day: string; tokens: number }[]
  days: number
}

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  })
}

export function DailyBars({ daily, days }: DailyBarsProps) {
  const max = daily.reduce((m, d) => Math.max(m, d.tokens), 0)
  const bw = daily.length > 0 ? (W - GAP * (daily.length - 1)) / daily.length : W
  const peak = daily.reduce<{ day: string; tokens: number } | null>(
    (best, d) => (d.tokens > 0 && (!best || d.tokens > best.tokens) ? d : best),
    null,
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionTitle>Conso quotidienne · {days} j</SectionTitle>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', maxWidth: W, height: 'auto' }}
        role="img"
        aria-label={`Consommation quotidienne sur ${days} jours`}
      >
        {daily.map((d, i) => {
          const active = d.tokens > 0
          // `max === 0` (aucune conso du tout) : tout au plancher vide. Sans ce
          // garde-fou la division produirait NaN et rien ne se dessinerait.
          const h = active ? Math.max(FLOOR_ACTIVE, (d.tokens / max) * USABLE) : FLOOR_EMPTY
          return (
            <rect
              key={d.day}
              x={i * (bw + GAP)}
              y={H - h}
              width={bw}
              height={h}
              rx={2}
              fill={active ? 'var(--accent)' : 'rgba(151, 173, 204, 0.15)'}
              opacity={active ? 0.45 + 0.55 * (d.tokens / max) : 1}
            >
              <title>
                {dayLabel(d.day)} ·{' '}
                {active ? `${d.tokens.toLocaleString('fr-FR')} tokens` : 'aucun run'}
              </title>
            </rect>
          )
        })}
        <line
          x1="0"
          y1={H - 0.5}
          x2={W}
          y2={H - 0.5}
          stroke="rgba(151, 173, 204, 0.18)"
          strokeWidth="1"
        />
      </svg>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          maxWidth: W,
          font: '10px var(--font-mono)',
          color: 'var(--text-low)',
        }}
      >
        <span>il y a {days} j</span>
        <span>
          {peak
            ? `pic : ${formatTokensShort(peak.tokens)} tokens · ${dayLabel(peak.day)}`
            : 'aucun run sur la période'}
        </span>
        <span>aujourd&rsquo;hui</span>
      </div>
      <Note>
        un jour sans run garde sa place dans la série, en gris · rien n&rsquo;est resserré
      </Note>
    </div>
  )
}

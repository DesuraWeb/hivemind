import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GlobeView } from '../../lib/api'
import { OrbCanvas } from '../OrbCanvas'
import { ORBIT, orbitRanks, particleCountOf, sizeOf } from './orbit'

const FALLBACK_TINT = 'var(--accent)'

function metaFor(g: GlobeView): string {
  const parts: string[] = []
  if (g.activeCount > 0)
    parts.push(
      `${g.activeCount} boucle${g.activeCount > 1 ? 's' : ''} active${g.activeCount > 1 ? 's' : ''}`,
    )
  if (g.pendingCount > 0) parts.push(`${g.pendingCount} en attente`)
  return parts.length > 0 ? parts.join(' · ') : 'tout est calme'
}

/**
 * Système solaire : Hive au centre, une orbite par globe (Globes.dc.html).
 *
 * Le prototype monte UN canvas WebGL par globe (`ChapoOrb.create` dans une
 * boucle, `componentDidMount`) : une orbe par globe, config exacte reprise
 * ci-dessous. La règle « une seule orbe par vue » de CLAUDE.md vise
 * Projets.dc.html (« Les globes par projet sont abandonnés, limite de
 * contextes WebGL » — potentiellement des dizaines de projets) ; ici il n'y a
 * que quelques globes, et le handoff fait foi au pixel près (arbitrage
 * Florian) : un `OrbCanvas` — donc un contexte WebGL — par globe, chacun géré
 * indépendamment (pause hors viewport/onglet caché + destroy au démontage,
 * déjà assurés par `create()` dans orb.js, cf. OrbCanvas.tsx).
 */
export function GlobesStage({ globes }: { globes: GlobeView[] }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const hostRefs = useRef(new Map<string, HTMLDivElement>())
  const ringRefs = useRef(new Map<number, SVGEllipseElement>())
  const ringsSvgRef = useRef<SVGSVGElement>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const hoveredIdRef = useRef<string | null>(null)
  useEffect(() => {
    hoveredIdRef.current = hoveredId
  }, [hoveredId])

  const weights = useMemo(() => globes.map((g) => g.projectCount), [globes])
  const ranks = useMemo(() => orbitRanks(weights), [weights])
  // Phase de départ répartie régulièrement sur le cercle : déterministe (pas
  // de Math.random()), stable entre deux rendus tant que la liste ne change pas.
  const phases = useMemo(
    () => globes.map((_, i) => (i / Math.max(1, globes.length)) * Math.PI * 2),
    [globes],
  )

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let t = 0
    let inView = true

    function frame(now: number) {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const slow = hoveredIdRef.current ? ORBIT.HOVER_SLOW : 1
      t += slow * dt

      const stage = stageRef.current
      if (!stage) return
      const w = stage.clientWidth
      const h = stage.clientHeight
      const base = Math.min(w, h)
      const cx = w / 2
      const cy = h * ORBIT.CY
      if (ringsSvgRef.current) ringsSvgRef.current.setAttribute('viewBox', `0 0 ${w} ${h}`)

      globes.forEach((g, i) => {
        const el = hostRefs.current.get(g.id)
        const rank = ranks[i] ?? 0
        const px = sizeOf(g.projectCount, weights)
        const hostW = px + 50
        // Marge de sécurité : le conteneur de l'orbe (OrbCanvas, observé par
        // l'IntersectionObserver d'orb.js — vendor/orb.js ~L300, root et
        // marge non configurables depuis l'extérieur) ne doit jamais friser
        // le bord de la scène. Constaté à l'instrumentation : dès que la
        // boîte quitte le cadre, son ratio d'intersection oscille pile/face
        // d'une frame à l'autre et `toggleLoop` (orb.js) coupe/relance la
        // boucle RAF en boucle → clignotement visible. R_STEP*rang n'est pas
        // borné (le nombre de globes ne l'est pas non plus, cf.
        // CreateGlobeForm), donc rang élevé ou fenêtre modeste suffisent à
        // pousser l'orbite jusqu'au bord. On borne ici le rayon effectif
        // (pas dans orbit.ts : ORBIT reprend le prototype telle quelle, cette
        // contrainte est propre au montage React, cf. commentaire du
        // composant plus haut) pour que même le globe le plus excentré reste
        // à EDGE_MARGIN du bord, verticalement (le plus contraignant : nom
        // au-dessus, méta + bouton « en attente » en dessous) comme
        // horizontalement.
        const EDGE_MARGIN = 32
        const CHROME_BELOW = 90 // méta + bouton « en attente » sous l'orbe
        const rMaxTop = (cy - px * 0.7 - EDGE_MARGIN) / ORBIT.SQUASH
        const rMaxBottom = (h - cy - px * 0.3 - CHROME_BELOW - EDGE_MARGIN) / ORBIT.SQUASH
        const rMaxX = cx - px / 2 - EDGE_MARGIN
        const r = Math.max(
          0,
          Math.min(base * (ORBIT.R0 + ORBIT.R_STEP * rank), rMaxTop, rMaxBottom, rMaxX),
        )
        const speed = ORBIT.SPEED * ORBIT.SPEED_FALLOFF ** rank
        const a = t * speed + (phases[i] ?? 0)
        const x = cx + Math.sin(a) * r
        const y = cy + Math.cos(a) * r * ORBIT.SQUASH
        if (el) {
          el.style.transform = `translate(${x - hostW / 2}px, ${y - px * 0.7}px)`
          el.style.zIndex = Math.cos(a) > 0 ? '12' : '8'
        }
        // Anneau d'orbite (Globes.dc.html : <ellipse ref="{{ ring0 }}"> etc.,
        // une ellipse par orbite, tracée derrière les globes). `rank` est déjà
        // un rang unique 0..n-1 (orbitRanks), donc directement l'index de
        // l'anneau correspondant.
        const ring = ringRefs.current.get(rank)
        if (ring) {
          ring.setAttribute('cx', String(cx))
          ring.setAttribute('cy', String(cy))
          ring.setAttribute('rx', String(r))
          ring.setAttribute('ry', String(r * ORBIT.SQUASH))
        }
      })
    }

    const toggle = () => {
      const run = !document.hidden && inView
      if (run && !raf) {
        last = performance.now()
        raf = requestAnimationFrame(frame)
      } else if (!run && raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }
    const onVis = () => toggle()
    document.addEventListener('visibilitychange', onVis)
    const io = new IntersectionObserver((entries) => {
      inView = entries[0]?.isIntersecting !== false
      toggle()
    })
    if (stageRef.current) io.observe(stageRef.current)
    toggle()

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
      io.disconnect()
    }
    // Les refs (hostRefs, hoveredIdRef) et les tableaux dérivés (weights,
    // ranks, phases) sont recalculés ci-dessus à partir de `globes` — le
    // relancer sur ces dépendances redémarre proprement la boucle avec les
    // nouvelles positions plutôt que de figer une fermeture obsolète.
  }, [globes, ranks, phases, weights])

  return (
    <div ref={stageRef} style={{ position: 'absolute', inset: 0 }}>
      <svg
        ref={ringsSvgRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 2,
        }}
      >
        {globes.map((_, rank) => (
          <ellipse
            // biome-ignore lint/suspicious/noArrayIndexKey: le rang d'orbite EST l'index (orbitRanks est une permutation de 0..n-1, un anneau par rang, cf. Globes.dc.html ring0/ring1/ring2).
            key={rank}
            ref={(el) => {
              if (el) ringRefs.current.set(rank, el)
              else ringRefs.current.delete(rank)
            }}
            fill="none"
            // Globes.dc.html : ring0 0.09, ring1 0.07, ring2 0.055 → ratio ~×0.78
            // par anneau ; formule généralisée pour un nombre de globes ≠ 3.
            stroke={`rgba(151, 190, 205, ${(0.09 * 0.78 ** rank).toFixed(4)})`}
            strokeWidth={1}
          />
        ))}
      </svg>

      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '47%',
          transform: 'translate(-50%, -50%)',
          zIndex: 5,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 999,
            background:
              'radial-gradient(circle at 35% 30%, color-mix(in oklab, var(--accent) 90%, white), var(--accent) 50%, color-mix(in oklab, var(--accent) 18%, transparent))',
            boxShadow: '0 0 34px var(--accent-glow)',
          }}
        />
        <span
          style={{
            font: '600 10px var(--font-mono)',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--text-low)',
          }}
        >
          Hive
        </span>
      </div>

      {globes.map((g) => {
        const px = sizeOf(g.projectCount, weights)
        const tint = g.color ?? FALLBACK_TINT
        const hovered = hoveredId === g.id
        // Seuils du prototype (Component.renderVals, `nameFs`) : 200/150, pas
        // 190/165 — écart repéré à l'audit pixel (rapport Task 8bis), corrigé
        // ici. Note : comme SIZE_MIN vaut 150 (ORBIT), le globe le plus petit
        // touche déjà le seuil ">= 150" pile, donc tous les globes affichés
        // (150 à 195 px) rendent en 14.5px tant qu'aucun ne dépasse 200px —
        // fidèle au prototype, pas une régression.
        const nameFs = px >= 200 ? 16 : px >= 150 ? 14.5 : 13.5
        const particleCount = particleCountOf(g.projectCount, weights)
        return (
          <div
            key={g.id}
            ref={(el) => {
              if (el) hostRefs.current.set(g.id, el)
              else hostRefs.current.delete(g.id)
            }}
            onMouseEnter={() => setHoveredId(g.id)}
            onMouseLeave={() => setHoveredId((cur) => (cur === g.id ? null : cur))}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: px + 50,
              zIndex: 10,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              willChange: 'transform',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ font: `600 ${nameFs}px var(--font-sans)`, whiteSpace: 'nowrap' }}>
                {g.name}
              </span>
              <span
                style={{
                  font: '10.5px var(--font-mono)',
                  color: 'var(--text-low)',
                  whiteSpace: 'nowrap',
                }}
              >
                {g.projectCount} projet{g.projectCount === 1 ? '' : 's'}
              </span>
            </div>
            <div style={{ width: px, height: px, position: 'relative' }}>
              <OrbCanvas
                projects={[{ id: g.id, name: g.name, tint, nodes: particleCount }]}
                config={{
                  PARTICLE_COUNT: particleCount,
                  VEIL_RATIO: 0.5,
                  CLUSTER_SPREAD: 1.1,
                  SHELL_THICKNESS: 0.12,
                  PARTICLE_SIZE: 0.05 + 0.014 * (px / ORBIT.SIZE_MAX),
                  SIZE_MAX: 1.7,
                  ALPHA: g.pendingCount > 0 ? 0.72 : 0.55,
                  TINT_MIX: 0.5,
                  ROT_SPEED: g.activeCount > 0 ? 0.12 : 0.05,
                  WOBBLE: 0.06,
                  JITTER_AMPL: 0.05,
                  PARALLAX: 0,
                  CAMERA_Z: 3.3,
                  HOVER_RADIUS_NDC: 0,
                }}
              />
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                minHeight: 16,
                font: '10.5px var(--font-mono)',
                color: 'var(--text-mid)',
              }}
            >
              {g.activeCount > 0 && (
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 999,
                    background: 'var(--accent)',
                    animation: 'chapoPulse 1.8s var(--ease) infinite',
                  }}
                />
              )}
              <span>{metaFor(g)}</span>
            </div>
            <div
              style={{
                display: 'flex',
                gap: 7,
                minHeight: 30,
                marginTop: 4,
                opacity: hovered ? 1 : 0,
                transform: hovered ? 'translateY(0px)' : 'translateY(5px)',
                pointerEvents: hovered ? 'auto' : 'none',
                transition:
                  'opacity var(--dur-2) var(--ease), transform var(--dur-2) var(--ease-out)',
              }}
            >
              {g.pendingCount > 0 && (
                <Link
                  to="/inbox"
                  style={{
                    padding: '6px 14px',
                    borderRadius: 'var(--r-full)',
                    border: '1px solid var(--line-strong)',
                    background: 'rgba(9, 14, 22, 0.8)',
                    color: 'var(--text-mid)',
                    font: '500 12px var(--font-sans)',
                  }}
                >
                  {g.pendingCount} en attente
                </Link>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { SectionHeader } from '../components/SectionHeader'
import { DecisionsTimeline } from '../components/journal/DecisionsTimeline'
import { NightTimeline } from '../components/journal/NightTimeline'
import { windowLabel } from '../components/journal/journal'
import { Pill, PillGroup } from '../components/journal/kit'
import { api } from '../lib/api'
import { subscribeToEvents } from '../lib/events'

const PROJECTS_QUERY_KEY = ['projects'] as const

/**
 * Fenêtres proposées, en heures. Le serveur borne à la rétention annoncée
 * (90 j) et refuse une valeur hors bornes plutôt que de la ramener au défaut —
 * ces trois valeurs restent donc largement dedans.
 *
 * Le prototype n'a pas ce sélecteur : son en-tête annonce une nuit fixe
 * (« nuit du 11 au 12 août »). Mais son onglet « Vos décisions » montre deux
 * journées, et le défaut du serveur est 24 h : sans sélecteur, la moitié du
 * contenu maquetté serait hors d'atteinte. Les pilules reprennent exactement
 * la forme de celles d'`Analytics.dc.html`, du même pack.
 */
const RANGES: { label: string; hours: number }[] = [
  { label: '24 h', hours: 24 },
  { label: '7 j', hours: 168 },
  { label: '30 j', hours: 720 },
]

type Tab = 'nuit' | 'decisions'

/**
 * Journal (`docs/design/Journal.dc.html`) : « Nuit des agents » et « Vos
 * décisions » fusionnés en un segmented control, et un lien profond
 * `#decisions` qui ouvre directement le second onglet.
 *
 * L'onglet actif vit dans le hash de l'URL, pas dans un état local : c'est ce
 * qui rend `/journal#decisions` partageable et le bouton Précédent du
 * navigateur cohérent. Cliquer un onglet est une navigation.
 *
 * Une seule requête pour les deux onglets (`GET /api/journal`), comme le
 * serveur l'a voulu : ils se lisent ensemble, l'écran a un segmented control,
 * pas deux pages.
 */
export function Journal() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const hash = useRouterState({ select: (s) => s.location.hash.replace(/^#/, '') })
  const tab: Tab = hash === 'decisions' ? 'decisions' : 'nuit'

  // La fenêtre reste un état local, pas une portion d'URL : l'onglet se
  // partage (`/journal#decisions`, c'est le lien profond du pack), la durée
  // qu'on regarde ne se partage pas. `validateSearch` vit de toute façon dans
  // `router.tsx`, qui appartient à une autre session.
  const [hours, setHours] = useState(24)

  const journalQuery = useQuery({
    queryKey: ['journal', hours] as const,
    queryFn: () => api.journal.get(hours),
  })
  const projectsQuery = useQuery({ queryKey: PROJECTS_QUERY_KEY, queryFn: api.projects.list })

  useEffect(() => {
    return subscribeToEvents((evt) => {
      // Une décision tranchée entre dans « Vos décisions », une passation dans
      // « Nuit des agents » : les deux vivent dans la même réponse.
      if (evt.type === 'inbox.resolved' || evt.type === 'run.state') {
        void queryClient.invalidateQueries({ queryKey: ['journal'] })
      }
    })
  }, [queryClient])

  const globeBySlug = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of projectsQuery.data ?? []) map.set(p.id, p.globe)
    return map
  }, [projectsQuery.data])

  function goTab(nextTab: Tab) {
    void navigate({ to: '/journal', hash: nextTab })
  }

  const data = journalQuery.data
  const nightCount = data?.night.length ?? 0
  const decisionCount = data?.decisions.length ?? 0

  const meta = data
    ? tab === 'nuit'
      ? `${windowLabel(data.window.since, data.window.until)} · ${nightCount} passation${
          nightCount > 1 ? 's' : ''
        }`
      : `vos arbitrages · auditables, non révocables · conservés ${data.retentionDays} j`
    : null

  return (
    <>
      <SectionHeader
        label="Journal"
        meta={
          <PillGroup>
            <Pill label="Nuit des agents" active={tab === 'nuit'} onClick={() => goTab('nuit')} />
            <Pill
              label="Vos décisions"
              active={tab === 'decisions'}
              onClick={() => goTab('decisions')}
            />
          </PillGroup>
        }
        right={
          <>
            {meta && (
              <span
                style={{
                  font: '11.5px var(--font-mono)',
                  color: 'var(--text-low)',
                }}
              >
                {meta}
              </span>
            )}
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {RANGES.map((r) => (
                <Pill
                  key={r.hours}
                  label={r.label}
                  active={hours === r.hours}
                  compact
                  onClick={() => setHours(r.hours)}
                />
              ))}
            </div>
          </>
        }
      />

      <main style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 20px 116px' }}>
        <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 24 }}>
          {journalQuery.isPending && (
            <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
              lecture du journal…
            </span>
          )}
          {journalQuery.isError && (
            <span style={{ font: '11.5px var(--font-mono)', color: 'var(--sem-alert)' }}>
              journal injoignable · rien n&rsquo;est perdu, la lecture se refait au prochain essai
            </span>
          )}
          {data && tab === 'nuit' && (
            <NightTimeline entries={data.night} retentionDays={data.retentionDays} />
          )}
          {data && tab === 'decisions' && (
            <DecisionsTimeline
              decisions={data.decisions}
              retentionDays={data.retentionDays}
              globeOf={(slug) => globeBySlug.get(slug) ?? null}
            />
          )}
          {data && tab === 'nuit' && decisionCount > 0 && nightCount === 0 && (
            <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
              {decisionCount} décision{decisionCount > 1 ? 's' : ''} sur la même fenêtre, dans
              l&rsquo;onglet « Vos décisions »
            </span>
          )}
        </div>
      </main>
    </>
  )
}

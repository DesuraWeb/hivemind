import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { SectionHeader } from '../components/SectionHeader'
import { DailyBars } from '../components/analytics/DailyBars'
import { ProjectCosts } from '../components/analytics/ProjectCosts'
import { StepCosts } from '../components/analytics/StepCosts'
import {
  MissingStat,
  RangeButton,
  Stat,
  formatEur,
  formatTokensShort,
} from '../components/analytics/kit'
import { api } from '../lib/api'
import { subscribeToEvents } from '../lib/events'

/** Les trois fenêtres du pack. Le serveur borne à 365 j et refuse au-delà. */
const RANGES = [7, 14, 30] as const

/**
 * Analytics · l'économie du système (`docs/design/Analytics.dc.html`).
 *
 * ## Ce que l'écran n'affiche pas
 *
 * **Les « heures humaines économisées »** (le grand nombre cyan du pack,
 * « estim. : runs × temps manuel ») : rien n'enregistre le temps qu'aurait
 * pris un step à la main. Le chiffre du prototype est une fixture divisée par
 * 16. Il aurait pu être « estimé » ici en trois lignes, et c'est exactement ce
 * qu'il ne faut pas faire : posé à côté d'un coût réel, un chiffre inventé
 * emprunte son autorité. L'emplacement reste, **nommé comme manquant**.
 *
 * **Le compte de runs, de décisions et leur ratio** : `GET /api/analytics` ne
 * les rend pas. Le troisième grand nombre porte donc les steps validés, que le
 * serveur calcule (`stepsDone`) — la contrepartie honnête du coût : ce qui a
 * été payé, et ce qui en est sorti.
 *
 * **« abonnement Max · réserve jamais entamée »** : l'état de la réserve
 * appartient à la jauge de budget, et « jamais entamée » est une affirmation
 * sur tout l'historique que rien ne vérifie.
 */
export function Analytics() {
  const queryClient = useQueryClient()
  const [days, setDays] = useState<number>(30)
  const [picked, setPicked] = useState<string | null>(null)

  const analyticsQuery = useQuery({
    queryKey: ['analytics', days] as const,
    queryFn: () => api.analytics.get(days),
  })

  useEffect(() => {
    return subscribeToEvents((evt) => {
      // Un run qui change d'état a consommé : la série et les totaux bougent.
      if (evt.type === 'run.state') {
        void queryClient.invalidateQueries({ queryKey: ['analytics'] })
      }
    })
  }, [queryClient])

  const data = analyticsQuery.data
  const perProject = data?.perProject ?? []
  // Le projet sélectionné retombe sur le plus cher tant que rien n'a été
  // cliqué, et si celui qui l'était sort de la fenêtre.
  const selected =
    picked && perProject.some((p) => p.id === picked) ? picked : (perProject[0]?.id ?? null)
  const selectedName = perProject.find((p) => p.id === selected)?.name ?? null
  const stepsDone = perProject.reduce((sum, p) => sum + p.stepsDone, 0)

  return (
    <>
      <SectionHeader
        label="Analytics · économie du système"
        meta={
          data
            ? `${data.days} derniers jours · coût estimé au tarif des réglages, jamais une facturation`
            : undefined
        }
        right={
          <div style={{ display: 'flex', gap: 6 }}>
            {RANGES.map((r) => (
              <RangeButton
                key={r}
                label={`${r} j`}
                active={days === r}
                onClick={() => setDays(r)}
              />
            ))}
          </div>
        }
      />

      <main style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '24px 20px 116px' }}>
        <div style={{ maxWidth: 880, display: 'flex', flexDirection: 'column', gap: 34 }}>
          {analyticsQuery.isPending && (
            <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
              lecture de la conso…
            </span>
          )}
          {analyticsQuery.isError && (
            <span style={{ font: '11.5px var(--font-mono)', color: 'var(--sem-alert)' }}>
              analytics injoignable · aucune conso n&rsquo;est perdue, seule la lecture a échoué
            </span>
          )}

          {data && (
            <>
              <div style={{ display: 'flex', gap: 56, flexWrap: 'wrap' }}>
                <Stat
                  value={formatEur(data.totalEur)}
                  label={`coût tokens · ${formatTokensShort(data.totalTokens)} tokens`}
                />
                <Stat
                  value={String(stepsDone)}
                  accent
                  label={`steps validés · ${perProject.length} projet${
                    perProject.length > 1 ? 's' : ''
                  } avec au moins un run`}
                />
                <MissingStat
                  label="heures humaines économisées"
                  why="aucune durée manuelle n'est enregistrée"
                />
              </div>

              <DailyBars daily={data.daily} days={data.days} />

              <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 44 }}>
                <ProjectCosts perProject={perProject} selected={selected} onSelect={setPicked} />
                <StepCosts projectId={selected} projectName={selectedName} />
              </div>
            </>
          )}
        </div>
      </main>
    </>
  )
}

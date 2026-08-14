import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { GHOST_BUTTON, Note, Panel } from './Panel'

/**
 * Les réglages réellement modifiables, et eux seuls.
 *
 * `PUT /api/settings` est la seule route d'écriture de cet écran. Trois clés y
 * ont un effet observable : la réserve et le seuil de reprise pilotent le
 * scheduler de budget, le prix indicatif fixe l'échelle en euros affichée sur
 * les projets. Tout le reste de `settings` (règles de stack, socle de réponse
 * de Hive, chemins gardés) se règle ailleurs ou pas encore : on ne pose pas un
 * champ pour une valeur qu'on ne saurait pas rendre correctement.
 */

const KEYS = {
  reserve: 'budget.reserve_pct',
  resume: 'budget.resume_pct',
  pricing: 'pricing.eur_per_mtok',
} as const

/** Défaut du serveur quand le réglage est absent (`DEFAULT_EUR_PER_MTOK`). */
const DEFAULT_EUR_PER_MTOK = 15

interface Field {
  key: string
  label: string
  hint: string
  /** Valeur actuelle, telle que le serveur la rend. */
  current: number
  min: number
  max: number
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function ThresholdsForm() {
  const queryClient = useQueryClient()
  const budget = useQuery({ queryKey: ['budget'], queryFn: api.budget.get })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.list })

  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [problem, setProblem] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async (changes: { key: string; value: number }[]) => {
      for (const change of changes) await api.settings.set(change.key, change.value)
      return changes.length
    },
    onSuccess: () => {
      setDrafts({})
      setProblem(null)
      void queryClient.invalidateQueries({ queryKey: ['budget'] })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err: Error) => setProblem(`enregistrement refusé · ${err.message}`),
  })

  if (budget.isPending || settings.isPending) {
    return (
      <Panel label="Seuils · modifiables">
        <Note>lecture des réglages…</Note>
      </Panel>
    )
  }

  if (budget.isError || settings.isError || !budget.data) {
    return (
      <Panel label="Seuils · modifiables">
        <Note>
          réglages injoignables · rien n&rsquo;est affiché plutôt qu&rsquo;un formulaire prérempli
          de valeurs inventées
        </Note>
      </Panel>
    )
  }

  const pricing = readNumber(settings.data[KEYS.pricing])
  const fields: Field[] = [
    {
      key: KEYS.reserve,
      label: 'Réserve (points de jauge)',
      hint: 'les derniers points, gardés pour un correctif urgent · le seuil de pause en découle',
      current: budget.data.reserve.pct,
      min: 0,
      max: 100,
    },
    {
      key: KEYS.resume,
      label: 'Seuil de reprise (%)',
      hint: 'sous ce niveau les boucles repartent · doit rester sous le seuil de pause',
      current: budget.data.thresholds.resume,
      min: 0,
      max: 100,
    },
    {
      key: KEYS.pricing,
      label: 'Prix indicatif (€ / M tokens)',
      hint: 'ordre de grandeur affiché sur les projets, jamais une facturation',
      current: pricing ?? DEFAULT_EUR_PER_MTOK,
      min: 0,
      max: 10_000,
    },
  ]

  const fieldValue = (f: Field): string => drafts[f.key] ?? String(f.current)
  const dirty = fields.filter((f) => fieldValue(f) !== String(f.current))

  const submit = () => {
    const changes: { key: string; value: number }[] = []
    for (const f of dirty) {
      const raw = fieldValue(f).replace(',', '.').trim()
      const value = Number(raw)
      if (raw === '' || !Number.isFinite(value) || value < f.min || value > f.max) {
        setProblem(`${f.label} : attendu un nombre entre ${f.min} et ${f.max}`)
        return
      }
      changes.push({ key: f.key, value })
    }

    // Le serveur retombe silencieusement sur sa bande par défaut si la reprise
    // n'est pas strictement sous la pause : on le refuse ici plutôt que de
    // laisser enregistrer une valeur qui ne sera pas celle qu'on relira.
    const reserve = changes.find((c) => c.key === KEYS.reserve)?.value ?? budget.data.reserve.pct
    const resume =
      changes.find((c) => c.key === KEYS.resume)?.value ?? budget.data.thresholds.resume
    if (resume >= 100 - reserve) {
      setProblem(
        `seuil de reprise à ${resume} % contre une pause à ${100 - reserve} % : il n’y aurait plus d’hystérésis, le serveur ignorerait la valeur`,
      )
      return
    }

    setProblem(null)
    save.mutate(changes)
  }

  return (
    <Panel
      label="Seuils · modifiables"
      right={
        <button
          type="button"
          className="reglages-ghost"
          onClick={submit}
          disabled={dirty.length === 0 || save.isPending}
          style={{
            ...GHOST_BUTTON,
            opacity: dirty.length === 0 || save.isPending ? 0.45 : 1,
            cursor: dirty.length === 0 ? 'default' : 'pointer',
          }}
        >
          {save.isPending ? 'enregistrement…' : 'Enregistrer'}
        </button>
      }
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
        {fields.map((f) => (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span
              style={{
                font: '600 10px var(--font-mono)',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--text-low)',
              }}
            >
              {f.label}
            </span>
            <input
              type="text"
              inputMode="decimal"
              className="reglages-field"
              value={fieldValue(f)}
              onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
              style={{
                background: 'var(--bg-2)',
                border: '1px solid var(--line-strong)',
                borderRadius: 'var(--r-md)',
                padding: '9px 11px',
                font: '500 12.5px var(--font-mono)',
                color: 'var(--text-hi)',
                outline: 'none',
              }}
            />
            <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
              {f.hint}
            </span>
          </label>
        ))}
      </div>

      {problem && (
        <span style={{ font: '11px var(--font-mono)', color: 'var(--sem-alert)', lineHeight: 1.7 }}>
          {problem}
        </span>
      )}

      {pricing === null && (
        <Note>
          prix indicatif absent des réglages · le serveur applique {DEFAULT_EUR_PER_MTOK} €/M tokens
          par défaut, enregistrer ici le pose en base
        </Note>
      )}

      <Note>
        ces trois valeurs prennent effet au prochain tick du scheduler, sans redéploiement · le
        serveur revalide tout ce qu&rsquo;il reçoit
      </Note>
    </Panel>
  )
}

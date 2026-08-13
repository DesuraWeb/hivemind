import { describe, expect, it } from 'vitest'
import { type UsageResponse, foldRateLimits, probeUsageOn } from '../src/runtime/usage'

/**
 * Aucun de ces tests ne parle au SDK ni au réseau : `foldRateLimits` est pure,
 * et `probeUsageOn` prend un objet structurel. La vérification que l'appel
 * réel est gratuit vit dans `scripts/diag-usage-api.ts`, pas ici — un test qui
 * dépenserait des tokens à chaque `pnpm test` serait exactement ce que la
 * règle du garant interdit.
 */

const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'

/** Réponse réellement observée le 13/08, réduite aux champs exploités. */
const REAL: UsageResponse = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 5, resets_at: '2026-08-13T15:39:59.573602+00:00' },
    seven_day: { utilization: 29, resets_at: '2026-08-18T17:59:59.573622+00:00' },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    // Buckets non documentés, réellement présents dans la réponse.
    nimbus_quill: { utilization: 0, resets_at: null },
    cinder_cove: null,
  },
}

describe('foldRateLimits', () => {
  it('lit les deux jauges et la remise à zéro de la fenêtre de 5 h', () => {
    const snap = foldRateLimits(REAL)
    expect(snap).not.toBeNull()
    expect(snap?.available).toBe(true)
    expect(snap?.fiveHourPct).toBe(5)
    expect(snap?.sevenDayPct).toBe(29)
    expect(snap?.resetsAt?.toISOString()).toBe('2026-08-13T15:39:59.573Z')
  })

  it('garde le MAXIMUM des fenêtres hebdomadaires, pas la première trouvée', () => {
    // Surestimer ne coûte qu'une pause prématurée ; sous-estimer ferait tourner
    // le scheduler au-delà de la limite réelle.
    const snap = foldRateLimits({
      rate_limits_available: true,
      rate_limits: {
        seven_day: { utilization: 12 },
        seven_day_opus: { utilization: 81 },
        seven_day_sonnet: { utilization: 40 },
      },
    })
    expect(snap?.sevenDayPct).toBe(81)
  })

  it("ignore un bucket inconnu qui ne relève d'aucune des deux fenêtres", () => {
    // `nimbus_quill: 99` ne doit pas déclencher une pause : on ne sait pas ce
    // qu'il compte.
    const snap = foldRateLimits({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 3 }, nimbus_quill: { utilization: 99 } },
    })
    expect(snap?.fiveHourPct).toBe(3)
    expect(snap?.sevenDayPct).toBe(0)
  })

  it('rend null quand les limites de plan ne s appliquent pas (clé API, Bedrock, Vertex)', () => {
    expect(foldRateLimits({ rate_limits_available: false, rate_limits: null })).toBeNull()
    // Même avec des fenêtres présentes, le drapeau fait foi.
    expect(
      foldRateLimits({
        rate_limits_available: false,
        rate_limits: { five_hour: { utilization: 7 } },
      }),
    ).toBeNull()
  })

  it('rend null quand aucune fenêtre ne porte de nombre', () => {
    expect(foldRateLimits({ rate_limits_available: true, rate_limits: {} })).toBeNull()
    expect(
      foldRateLimits({
        rate_limits_available: true,
        rate_limits: { five_hour: null, seven_day: { utilization: null } },
      }),
    ).toBeNull()
  })

  it('accepte une remise à zéro absente ou illisible sans perdre les jauges', () => {
    const snap = foldRateLimits({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 44, resets_at: 'pas une date' } },
    })
    expect(snap?.fiveHourPct).toBe(44)
    expect(snap?.resetsAt).toBeUndefined()
  })
})

describe('probeUsageOn', () => {
  it('interroge la méthode et ferme la session', async () => {
    let interrupted = false
    const snap = await probeUsageOn({
      [USAGE_METHOD]: async () => REAL,
      interrupt: async () => {
        interrupted = true
      },
    } as never)

    expect(snap?.fiveHourPct).toBe(5)
    // Sans interrupt(), le sous-processus du SDK survit : un orphelin par tick de cron.
    expect(interrupted).toBe(true)
  })

  it('rend null si la méthode a disparu du SDK, sans rien casser', async () => {
    // Le nom même de la méthode annonce qu'elle peut disparaître.
    const snap = await probeUsageOn({ interrupt: async () => {} })
    expect(snap).toBeNull()
  })

  it('rend null si la méthode échoue, et ferme quand même la session', async () => {
    let interrupted = false
    const snap = await probeUsageOn({
      [USAGE_METHOD]: async () => {
        throw new Error('transport fermé')
      },
      interrupt: async () => {
        interrupted = true
      },
    } as never)

    expect(snap).toBeNull()
    expect(interrupted).toBe(true)
  })

  it("n'échoue pas quand interrupt() lui-même jette", async () => {
    const snap = await probeUsageOn({
      [USAGE_METHOD]: async () => REAL,
      interrupt: async () => {
        throw new Error('rien à interrompre')
      },
    } as never)
    expect(snap?.sevenDayPct).toBe(29)
  })
})

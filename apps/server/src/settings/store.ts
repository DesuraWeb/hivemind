import type { Kysely } from 'kysely'
import type { SecretBox } from '../crypto/secrets'
import type { Database } from '../db/types'

/** Enveloppe stockée pour les valeurs secrètes. */
interface SealedValue {
  __sealed: true
  data: string
}

function isSealed(value: unknown): value is SealedValue {
  return typeof value === 'object' && value !== null && '__sealed' in value
}

export interface SettingsStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  getSecret(key: string): Promise<string | undefined>
  setSecret(key: string, value: string): Promise<void>
  /** Tous les réglages, secrets remplacés par `***`. Sûr à renvoyer par l'API. */
  listPublic(): Promise<Record<string, unknown>>
}

export function createSettingsStore(db: Kysely<Database>, box: SecretBox): SettingsStore {
  async function readRaw(key: string): Promise<unknown> {
    const row = await db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst()
    return row?.value
  }

  async function writeRaw(key: string, value: unknown): Promise<void> {
    await db
      .insertInto('settings')
      .values({ key, value: JSON.stringify(value) })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: new Date() }),
      )
      .execute()
  }

  return {
    async get<T>(key: string) {
      const value = await readRaw(key)
      if (value === undefined || isSealed(value)) return undefined
      return value as T
    },

    set: writeRaw,

    async getSecret(key) {
      const value = await readRaw(key)
      if (!isSealed(value)) return undefined
      return box.decryptJson<string>(value.data)
    },

    async setSecret(key, value) {
      await writeRaw(key, { __sealed: true, data: box.encryptJson(value) } satisfies SealedValue)
    },

    async listPublic() {
      const rows = await db.selectFrom('settings').selectAll().execute()
      const out: Record<string, unknown> = {}
      for (const row of rows) {
        out[row.key] = isSealed(row.value) ? '***' : row.value
      }
      return out
    },
  }
}

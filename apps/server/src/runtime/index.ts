import type { Env } from '../env'
import { createFakeAdapter } from './fake'
import type { RuntimeAdapter } from './types'

export async function createRuntimeAdapter(env: Env): Promise<RuntimeAdapter> {
  if (env.RUNTIME_ADAPTER === 'fake') return createFakeAdapter()
  const { createClaudeAdapter } = await import('./claude')
  return createClaudeAdapter()
}

export type * from './types'

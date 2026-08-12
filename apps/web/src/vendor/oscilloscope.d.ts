// Déclaration de types pour oscilloscope.js (JS vanille du pack DA, non modifié).
// Ne reflète que l'API publique réellement consommée par HiveStrip ; les
// détails internes du rendu restent non typés côté pack.

export type OscilloscopeState = 'idle' | 'listen' | 'speak' | (string & {})

export type OscilloscopeSource = (out: Float32Array, state: OscilloscopeState) => void

export interface OscilloscopeOptions {
  state?: OscilloscopeState
  config?: Record<string, unknown>
  source?: OscilloscopeSource
  onState?: (state: OscilloscopeState) => void
}

export interface OscilloscopeInstance {
  setState(state: OscilloscopeState): void
  readonly state: OscilloscopeState
  setSource(fn: OscilloscopeSource): void
  destroy(): void
}

export declare const OSC_CONFIG: Record<string, unknown>
export declare function fakeVoiceSource(speed?: number): OscilloscopeSource
export declare function create(
  container: HTMLElement,
  opts?: OscilloscopeOptions,
): OscilloscopeInstance

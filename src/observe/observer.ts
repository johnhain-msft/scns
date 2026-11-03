import type { ObservationType } from './types.js'

/** Lifecycle state for an observer */
export type ObserverState = 'idle' | 'running' | 'stopping' | 'error'

/** Common interface that all observers implement */
export interface Observer {
  readonly type: ObservationType
  readonly name: string
  start(): void
  stop(): void
  isRunning(): boolean
}

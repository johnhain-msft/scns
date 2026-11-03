import type { Observer, ObserverState } from './observer.js'
import type { z } from 'zod'

/** Capabilities an observer plugin can declare */
export const ObserverCapability = {
  Sessions: 'sessions',
  Tools: 'tools',
  Files: 'files',
  System: 'system',
  Network: 'network',
  Custom: 'custom',
} as const

export type ObserverCapability = (typeof ObserverCapability)[keyof typeof ObserverCapability]

/** Health status for an observer plugin */
export interface ObserverHealth {
  readonly healthy: boolean
  readonly message: string
  readonly lastCheck: string
  readonly details?: Record<string, unknown>
}

/** Plugin metadata */
export interface PluginMetadata {
  readonly name: string
  readonly version: string
  readonly source: string
  readonly description?: string
  readonly author?: string
}

/** Extended observer interface for plugins */
export interface ObserverPlugin extends Observer {
  readonly metadata: PluginMetadata
  readonly capabilities: readonly ObserverCapability[]
  readonly state: ObserverState
  configure(config: Record<string, unknown>): void
  getConfigSchema(): z.ZodType
  healthCheck(): Promise<ObserverHealth>
}

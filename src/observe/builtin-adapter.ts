/**
 * BuiltinObserverAdapter — wraps an existing Observer to satisfy ObserverPlugin.
 * This allows gradual migration without rewriting all 7 observers.
 */

import type { Observer, ObserverState } from './observer.js'
import type {
  ObserverPlugin,
  ObserverHealth,
  PluginMetadata,
  ObserverCapability,
} from './plugin.js'
import { z } from 'zod'

export interface AdapterOptions {
  readonly version?: string
  readonly description?: string
  readonly capabilities?: readonly ObserverCapability[]
}

/** Wrap an existing Observer to satisfy the ObserverPlugin interface */
export function createBuiltinAdapter(observer: Observer, options?: AdapterOptions): ObserverPlugin {
  const metadata: Readonly<PluginMetadata> = Object.freeze({
    name: observer.name,
    version: options?.version ?? '1.0.0',
    source: `@scns/${observer.type}`,
    description: options?.description ?? `Built-in ${observer.type} observer`,
  })

  const plugin: ObserverPlugin = {
    type: observer.type,
    name: observer.name,

    start(): void {
      observer.start()
    },

    stop(): void {
      observer.stop()
    },

    isRunning(): boolean {
      return observer.isRunning()
    },

    metadata,
    capabilities: options?.capabilities ?? ['custom'],

    get state(): ObserverState {
      return observer.isRunning() ? 'running' : 'idle'
    },

    configure(): void {
      // Built-in observers are not reconfigurable at runtime
    },

    getConfigSchema(): z.ZodType {
      return z.record(z.unknown())
    },

    async healthCheck(): Promise<ObserverHealth> {
      const running = observer.isRunning()
      return {
        healthy: true,
        message: running ? 'Running' : 'Idle',
        lastCheck: new Date().toISOString(),
      }
    },
  }

  return plugin
}

import type { ObserverPlugin, ObserverHealth } from './plugin.js'
import { logger } from '../shared/logger.js'
import { InvalidStateError } from '../shared/errors.js'

export interface PluginRegistryOptions {
  readonly pluginDirs?: readonly string[]
  readonly autoDiscover?: boolean
}

export function createPluginRegistry(_options?: PluginRegistryOptions) {
  const log = logger.child({ module: 'plugin-registry' })
  const plugins = new Map<string, ObserverPlugin>()

  return {
    /** Register a plugin instance */
    register(plugin: ObserverPlugin): void {
      const source = plugin.metadata.source
      if (plugins.has(source)) {
        throw new InvalidStateError(`Plugin with source '${source}' is already registered`)
      }
      plugins.set(source, plugin)
      log.info({ source, name: plugin.metadata.name }, 'Plugin registered')
    },

    /** Unregister a plugin by source identifier */
    unregister(source: string): boolean {
      const plugin = plugins.get(source)
      if (!plugin) return false

      if (plugin.isRunning()) {
        try {
          plugin.stop()
        } catch (err) {
          log.warn({ err, source }, 'Error stopping plugin during unregister')
        }
      }

      plugins.delete(source)
      log.info({ source }, 'Plugin unregistered')
      return true
    },

    /** Get a registered plugin by source */
    get(source: string): ObserverPlugin | undefined {
      return plugins.get(source)
    },

    /** List all registered plugins */
    list(): readonly ObserverPlugin[] {
      return Object.freeze([...plugins.values()])
    },

    /** Get health status for all plugins */
    async healthCheck(): Promise<ReadonlyMap<string, ObserverHealth>> {
      const entries = [...plugins.entries()]
      const results = await Promise.allSettled(
        entries.map(async ([source, plugin]) => {
          const health = await plugin.healthCheck()
          return [source, health] as const
        }),
      )

      const healthMap = new Map<string, ObserverHealth>()
      for (let i = 0; i < entries.length; i++) {
        const result = results[i]!
        const source = entries[i]![0]
        if (result.status === 'fulfilled') {
          healthMap.set(source, result.value[1])
        } else {
          const message =
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          healthMap.set(source, {
            healthy: false,
            message,
            lastCheck: new Date().toISOString(),
          })
        }
      }

      return healthMap
    },

    /** Start all registered plugins */
    startAll(): void {
      for (const [source, plugin] of plugins) {
        try {
          plugin.start()
        } catch (err) {
          log.warn({ err, source }, 'Failed to start plugin')
        }
      }
    },

    /** Stop all registered plugins (reverse insertion order) */
    stopAll(): void {
      const entries = [...plugins.entries()].reverse()
      for (const [source, plugin] of entries) {
        try {
          plugin.stop()
        } catch (err) {
          log.warn({ err, source }, 'Failed to stop plugin')
        }
      }
    },

    /** Get count of registered plugins */
    size(): number {
      return plugins.size
    },
  }
}

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPluginRegistry } from '../../../src/observe/plugin-registry.js'
import { createMockPlugin } from './plugin.test.js'

// Suppress pino logs in tests
vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}))

describe('createPluginRegistry', () => {
  let registry: ReturnType<typeof createPluginRegistry>

  beforeEach(() => {
    registry = createPluginRegistry()
  })

  describe('register', () => {
    it('registers a plugin', () => {
      const plugin = createMockPlugin()
      registry.register(plugin)
      expect(registry.size()).toBe(1)
    })

    it('throws on duplicate source', () => {
      const plugin1 = createMockPlugin()
      const plugin2 = createMockPlugin()
      registry.register(plugin1)
      expect(() => registry.register(plugin2)).toThrow(/already registered/)
    })

    it('allows multiple plugins with different sources', () => {
      const plugin1 = createMockPlugin({
        metadata: { name: 'P1', version: '1.0.0', source: 'source-a' },
      })
      const plugin2 = createMockPlugin({
        metadata: { name: 'P2', version: '1.0.0', source: 'source-b' },
      })
      registry.register(plugin1)
      registry.register(plugin2)
      expect(registry.size()).toBe(2)
    })
  })

  describe('unregister', () => {
    it('removes a registered plugin', () => {
      const plugin = createMockPlugin()
      registry.register(plugin)
      expect(registry.unregister('mock-source')).toBe(true)
      expect(registry.size()).toBe(0)
    })

    it('returns false for non-existent source', () => {
      expect(registry.unregister('nonexistent')).toBe(false)
    })

    it('stops the plugin before unregistering if running', () => {
      const plugin = createMockPlugin()
      registry.register(plugin)
      plugin.start()
      expect(plugin.isRunning()).toBe(true)
      registry.unregister('mock-source')
      expect(plugin.isRunning()).toBe(false)
    })
  })

  describe('get', () => {
    it('returns a registered plugin by source', () => {
      const plugin = createMockPlugin()
      registry.register(plugin)
      const result = registry.get('mock-source')
      expect(result).toBe(plugin)
    })

    it('returns undefined for unknown source', () => {
      expect(registry.get('unknown')).toBeUndefined()
    })
  })

  describe('list', () => {
    it('returns empty array when no plugins registered', () => {
      expect(registry.list()).toEqual([])
    })

    it('returns all registered plugins', () => {
      const plugin1 = createMockPlugin({
        metadata: { name: 'P1', version: '1.0.0', source: 'a' },
      })
      const plugin2 = createMockPlugin({
        metadata: { name: 'P2', version: '1.0.0', source: 'b' },
      })
      registry.register(plugin1)
      registry.register(plugin2)
      const list = registry.list()
      expect(list).toHaveLength(2)
    })

    it('returns a readonly snapshot', () => {
      const plugin = createMockPlugin()
      registry.register(plugin)
      const list = registry.list()
      expect(Object.isFrozen(list)).toBe(true)
    })
  })

  describe('healthCheck', () => {
    it('returns health for all registered plugins', async () => {
      const plugin = createMockPlugin()
      registry.register(plugin)
      const results = await registry.healthCheck()
      expect(results.size).toBe(1)
      const health = results.get('mock-source')
      expect(health?.healthy).toBe(true)
    })

    it('returns empty map with no plugins', async () => {
      const results = await registry.healthCheck()
      expect(results.size).toBe(0)
    })

    it('handles plugin healthCheck failure gracefully', async () => {
      const plugin = createMockPlugin({
        async healthCheck() {
          throw new Error('health check exploded')
        },
      })
      registry.register(plugin)
      const results = await registry.healthCheck()
      const health = results.get('mock-source')
      expect(health?.healthy).toBe(false)
      expect(health?.message).toContain('health check exploded')
    })

    it('reports results for multiple plugins independently', async () => {
      const healthy = createMockPlugin({
        metadata: { name: 'Healthy', version: '1.0.0', source: 'healthy' },
      })
      const unhealthy = createMockPlugin({
        metadata: { name: 'Unhealthy', version: '1.0.0', source: 'unhealthy' },
        async healthCheck() {
          return {
            healthy: false,
            message: 'Down',
            lastCheck: new Date().toISOString(),
          }
        },
      })
      registry.register(healthy)
      registry.register(unhealthy)

      const results = await registry.healthCheck()
      expect(results.get('healthy')?.healthy).toBe(true)
      expect(results.get('unhealthy')?.healthy).toBe(false)
    })
  })

  describe('startAll', () => {
    it('starts all registered plugins', () => {
      const p1 = createMockPlugin({
        metadata: { name: 'P1', version: '1.0.0', source: 'a' },
      })
      const p2 = createMockPlugin({
        metadata: { name: 'P2', version: '1.0.0', source: 'b' },
      })
      registry.register(p1)
      registry.register(p2)
      registry.startAll()
      expect(p1.isRunning()).toBe(true)
      expect(p2.isRunning()).toBe(true)
    })

    it('continues starting other plugins if one throws', () => {
      const failing = createMockPlugin({
        metadata: { name: 'Failing', version: '1.0.0', source: 'fail' },
        start() {
          throw new Error('start failed')
        },
      })
      const ok = createMockPlugin({
        metadata: { name: 'OK', version: '1.0.0', source: 'ok' },
      })
      registry.register(failing)
      registry.register(ok)
      registry.startAll()
      expect(ok.isRunning()).toBe(true)
    })

    it('does nothing with no plugins', () => {
      expect(() => registry.startAll()).not.toThrow()
    })
  })

  describe('stopAll', () => {
    it('stops all registered plugins', () => {
      const p1 = createMockPlugin({
        metadata: { name: 'P1', version: '1.0.0', source: 'a' },
      })
      const p2 = createMockPlugin({
        metadata: { name: 'P2', version: '1.0.0', source: 'b' },
      })
      registry.register(p1)
      registry.register(p2)
      registry.startAll()
      registry.stopAll()
      expect(p1.isRunning()).toBe(false)
      expect(p2.isRunning()).toBe(false)
    })

    it('continues stopping other plugins if one throws', () => {
      const failing = createMockPlugin({
        metadata: { name: 'Failing', version: '1.0.0', source: 'fail' },
        stop() {
          throw new Error('stop failed')
        },
      })
      const ok = createMockPlugin({
        metadata: { name: 'OK', version: '1.0.0', source: 'ok' },
      })
      registry.register(failing)
      registry.register(ok)
      registry.startAll()
      registry.stopAll()
      expect(ok.isRunning()).toBe(false)
    })

    it('does nothing with no plugins', () => {
      expect(() => registry.stopAll()).not.toThrow()
    })
  })

  describe('size', () => {
    it('returns 0 initially', () => {
      expect(registry.size()).toBe(0)
    })

    it('tracks registrations', () => {
      registry.register(createMockPlugin())
      expect(registry.size()).toBe(1)
    })

    it('tracks unregistrations', () => {
      registry.register(createMockPlugin())
      registry.unregister('mock-source')
      expect(registry.size()).toBe(0)
    })
  })
})

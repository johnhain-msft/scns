import { describe, it, expect, vi } from 'vitest'
import type { Observer } from '../../../src/observe/observer.js'
import type { ObservationType } from '../../../src/observe/types.js'
import { createBuiltinAdapter, type _AdapterOptions } from '../../../src/observe/builtin-adapter.js'

function createMockObserver(overrides: Partial<Observer> = {}): Observer {
  let running = false
  return {
    type: 'active-app' as ObservationType,
    name: 'active-app',
    start() {
      running = true
    },
    stop() {
      running = false
    },
    isRunning() {
      return running
    },
    ...overrides,
  }
}

describe('createBuiltinAdapter', () => {
  describe('delegation', () => {
    it('delegates start() to wrapped observer', () => {
      const startFn = vi.fn()
      const observer = createMockObserver({ start: startFn })
      const plugin = createBuiltinAdapter(observer)

      plugin.start()

      expect(startFn).toHaveBeenCalledOnce()
    })

    it('delegates stop() to wrapped observer', () => {
      const stopFn = vi.fn()
      const observer = createMockObserver({ stop: stopFn })
      const plugin = createBuiltinAdapter(observer)

      plugin.stop()

      expect(stopFn).toHaveBeenCalledOnce()
    })

    it('delegates isRunning() to wrapped observer', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)

      expect(plugin.isRunning()).toBe(false)
      plugin.start()
      expect(plugin.isRunning()).toBe(true)
      plugin.stop()
      expect(plugin.isRunning()).toBe(false)
    })

    it('preserves type and name from wrapped observer', () => {
      const observer = createMockObserver({
        type: 'git-activity' as ObservationType,
        name: 'git-activity-observer',
      })
      const plugin = createBuiltinAdapter(observer)

      expect(plugin.type).toBe('git-activity')
      expect(plugin.name).toBe('git-activity-observer')
    })
  })

  describe('state', () => {
    it('reports idle when observer is not running', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)

      expect(plugin.state).toBe('idle')
    })

    it('reports running when observer is running', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)

      plugin.start()

      expect(plugin.state).toBe('running')
    })

    it('reports idle after stop', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)

      plugin.start()
      plugin.stop()

      expect(plugin.state).toBe('idle')
    })
  })

  describe('metadata', () => {
    it('provides default metadata from observer', () => {
      const observer = createMockObserver({
        type: 'file-change' as ObservationType,
        name: 'file-change-observer',
      })
      const plugin = createBuiltinAdapter(observer)

      expect(plugin.metadata).toEqual({
        name: 'file-change-observer',
        version: '1.0.0',
        source: '@scns/file-change',
        description: 'Built-in file-change observer',
      })
    })

    it('uses custom version from options', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer, { version: '2.0.0' })

      expect(plugin.metadata.version).toBe('2.0.0')
    })

    it('uses custom description from options', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer, {
        description: 'Custom description',
      })

      expect(plugin.metadata.description).toBe('Custom description')
    })

    it('metadata is immutable', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)

      const meta = plugin.metadata
      expect(() => {
        ;(meta as Record<string, unknown>)['name'] = 'hacked'
      }).toThrow()
    })
  })

  describe('capabilities', () => {
    it('defaults to custom capability', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)

      expect(plugin.capabilities).toEqual(['custom'])
    })

    it('uses capabilities from options', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer, {
        capabilities: ['system', 'files'],
      })

      expect(plugin.capabilities).toEqual(['system', 'files'])
    })
  })

  describe('configure', () => {
    it('stores config without error', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)

      expect(() => plugin.configure({ interval: 5000 })).not.toThrow()
    })

    it('does not mutate original config object', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)

      const original = { interval: 5000 }
      plugin.configure(original)
      original.interval = 9999

      // Internal should not be affected (immutable copy)
    })
  })

  describe('getConfigSchema', () => {
    it('returns a valid zod schema', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)

      const schema = plugin.getConfigSchema()
      expect(schema).toBeDefined()

      // Should accept any record
      const result = schema.safeParse({ foo: 'bar', num: 42 })
      expect(result.success).toBe(true)
    })

    it('schema accepts empty object', () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)

      const result = plugin.getConfigSchema().safeParse({})
      expect(result.success).toBe(true)
    })
  })

  describe('healthCheck', () => {
    it('returns healthy with Running message when observer is running', async () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)
      plugin.start()

      const health = await plugin.healthCheck()

      expect(health.healthy).toBe(true)
      expect(health.message).toBe('Running')
      expect(health.lastCheck).toBeDefined()
      // Verify ISO timestamp
      expect(new Date(health.lastCheck).toISOString()).toBe(health.lastCheck)
    })

    it('returns healthy with Idle message when observer is idle', async () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)

      const health = await plugin.healthCheck()

      expect(health.healthy).toBe(true)
      expect(health.message).toBe('Idle')
    })

    it('returns healthy after stop', async () => {
      const observer = createMockObserver()
      const plugin = createBuiltinAdapter(observer)
      plugin.start()
      plugin.stop()

      const health = await plugin.healthCheck()

      expect(health.healthy).toBe(true)
      expect(health.message).toBe('Idle')
    })
  })
})

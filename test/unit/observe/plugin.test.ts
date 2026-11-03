import { describe, it, expect } from 'vitest'
import type { ObserverPlugin, ObserverHealth, PluginMetadata } from '../../../src/observe/plugin.js'
import { ObserverCapability } from '../../../src/observe/plugin.js'
import type { ObserverState } from '../../../src/observe/observer.js'
import { z } from 'zod'

/** Reusable mock plugin factory for tests across this module */
export function createMockPlugin(overrides?: Partial<ObserverPlugin>): ObserverPlugin {
  let running = false
  let currentState: ObserverState = 'idle'
  let _currentConfig: Record<string, unknown> = {}

  return {
    type: 'session-hook',
    name: 'mock-plugin',
    metadata: {
      name: 'Mock Plugin',
      version: '1.0.0',
      source: 'mock-source',
      description: 'A mock plugin for testing',
      author: 'Test Author',
    },
    capabilities: [ObserverCapability.Sessions, ObserverCapability.Custom],
    get state() {
      return currentState
    },
    start() {
      running = true
      currentState = 'running'
    },
    stop() {
      running = false
      currentState = 'idle'
    },
    isRunning() {
      return running
    },
    configure(config: Record<string, unknown>) {
      _currentConfig = { ...config }
    },
    getConfigSchema() {
      return z.object({ pollInterval: z.number().optional() })
    },
    async healthCheck(): Promise<ObserverHealth> {
      return {
        healthy: true,
        message: 'OK',
        lastCheck: new Date().toISOString(),
      }
    },
    ...overrides,
  }
}

describe('ObserverCapability', () => {
  it('has all expected capability values', () => {
    expect(ObserverCapability.Sessions).toBe('sessions')
    expect(ObserverCapability.Tools).toBe('tools')
    expect(ObserverCapability.Files).toBe('files')
    expect(ObserverCapability.System).toBe('system')
    expect(ObserverCapability.Network).toBe('network')
    expect(ObserverCapability.Custom).toBe('custom')
  })

  it('has exactly 6 capabilities', () => {
    expect(Object.keys(ObserverCapability)).toHaveLength(6)
  })
})

describe('ObserverHealth', () => {
  it('represents a healthy status', () => {
    const health: ObserverHealth = {
      healthy: true,
      message: 'All systems operational',
      lastCheck: '2025-01-15T10:00:00Z',
    }
    expect(health.healthy).toBe(true)
    expect(health.message).toBe('All systems operational')
    expect(health.lastCheck).toBe('2025-01-15T10:00:00Z')
    expect(health.details).toBeUndefined()
  })

  it('includes optional details', () => {
    const health: ObserverHealth = {
      healthy: false,
      message: 'Connection failed',
      lastCheck: '2025-01-15T10:00:00Z',
      details: { errorCode: 'ECONNREFUSED', retries: 3 },
    }
    expect(health.healthy).toBe(false)
    expect(health.details).toEqual({ errorCode: 'ECONNREFUSED', retries: 3 })
  })
})

describe('PluginMetadata', () => {
  it('contains required fields', () => {
    const meta: PluginMetadata = {
      name: 'My Plugin',
      version: '2.1.0',
      source: 'my-plugin',
    }
    expect(meta.name).toBe('My Plugin')
    expect(meta.version).toBe('2.1.0')
    expect(meta.source).toBe('my-plugin')
    expect(meta.description).toBeUndefined()
    expect(meta.author).toBeUndefined()
  })

  it('includes optional fields', () => {
    const meta: PluginMetadata = {
      name: 'My Plugin',
      version: '2.1.0',
      source: 'my-plugin',
      description: 'Watches things',
      author: 'Jane',
    }
    expect(meta.description).toBe('Watches things')
    expect(meta.author).toBe('Jane')
  })
})

describe('ObserverPlugin mock implementation', () => {
  it('can be constructed via createMockPlugin', () => {
    const plugin = createMockPlugin()
    expect(plugin.name).toBe('mock-plugin')
    expect(plugin.type).toBe('session-hook')
    expect(plugin.state).toBe('idle')
    expect(plugin.isRunning()).toBe(false)
  })

  it('transitions state on start/stop', () => {
    const plugin = createMockPlugin()
    plugin.start()
    expect(plugin.state).toBe('running')
    expect(plugin.isRunning()).toBe(true)
    plugin.stop()
    expect(plugin.state).toBe('idle')
    expect(plugin.isRunning()).toBe(false)
  })

  it('can configure with a config object', () => {
    const plugin = createMockPlugin()
    plugin.configure({ pollInterval: 5000 })
    // configure is a void method; just verify no throw
  })

  it('returns a Zod schema from getConfigSchema', () => {
    const plugin = createMockPlugin()
    const schema = plugin.getConfigSchema()
    expect(schema).toBeDefined()
    const result = schema.safeParse({ pollInterval: 1000 })
    expect(result.success).toBe(true)
  })

  it('returns health check result', async () => {
    const plugin = createMockPlugin()
    const health = await plugin.healthCheck()
    expect(health.healthy).toBe(true)
    expect(health.message).toBe('OK')
    expect(health.lastCheck).toBeTruthy()
  })

  it('exposes capabilities', () => {
    const plugin = createMockPlugin()
    expect(plugin.capabilities).toContain('sessions')
    expect(plugin.capabilities).toContain('custom')
  })

  it('exposes metadata', () => {
    const plugin = createMockPlugin()
    expect(plugin.metadata.name).toBe('Mock Plugin')
    expect(plugin.metadata.version).toBe('1.0.0')
    expect(plugin.metadata.source).toBe('mock-source')
  })

  it('allows overriding via createMockPlugin', () => {
    const plugin = createMockPlugin({
      name: 'custom-name',
      capabilities: [ObserverCapability.Network],
    })
    expect(plugin.name).toBe('custom-name')
    expect(plugin.capabilities).toEqual([ObserverCapability.Network])
  })
})

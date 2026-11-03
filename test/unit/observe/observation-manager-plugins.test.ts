import { describe, it, expect, vi } from 'vitest'
import type { Observer } from '../../../src/observe/observer.js'
import type { ObservationType, Observation, _ObserverConfig } from '../../../src/observe/types.js'
import type { ObservationConfig } from '../../../src/observe/config.js'
import type { SessionEventData } from '../../../src/observe/observers/session-hooks.js'
import type { _ObserverPlugin } from '../../../src/observe/plugin.js'
import {
  createObservationManager,
  type ObserverFactory,
  type ObservationManagerOptions,
} from '../../../src/observe/observation-manager.js'

// ─── Mock helpers ────────────────────────────────────────────────

function createMockObserver(
  type: string,
  name: string,
  overrides: Partial<Observer> = {},
): Observer {
  let running = false
  return {
    type: type as ObservationType,
    name,
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

function createMockSessionHookObserver() {
  const base = createMockObserver('session-hook', 'session-hook')
  const handleEvent = vi.fn(
    (event: SessionEventData): Observation => ({
      id: 'mock-id',
      type: 'session-hook' as ObservationType,
      timestamp: event.timestamp,
      source: event.event,
      content: `Session ${event.sessionId ?? 'unknown'}`,
      tags: [],
    }),
  )
  return { ...base, handleEvent }
}

function createMockFactory(overrides: Partial<ObserverFactory> = {}): ObserverFactory {
  return {
    createActiveApp: () => createMockObserver('active-app', 'active-app'),
    createBrowserTabs: () => createMockObserver('browser-tab', 'browser-tab'),
    createFileChanges: () => createMockObserver('file-change', 'file-change-observer'),
    createGitActivity: () => createMockObserver('git-activity', 'git-activity-observer'),
    createTerminalHistory: () => createMockObserver('terminal-history', 'terminal-history'),
    createSessionHooks: () => createMockSessionHookObserver(),
    createConfigChanges: () => createMockObserver('config-change', 'config-change-observer'),
    ...overrides,
  }
}

function defaultConfig(overrides: Partial<ObservationConfig> = {}): ObservationConfig {
  return {
    privacy: {
      excludeApps: [],
      excludePaths: [],
      excludeUrls: [],
      sanitizeSecrets: true,
      terminalHistoryOptIn: false,
      browserTabsOptIn: false,
    },
    activeApp: { enabled: true, intervalMs: 30_000, optIn: false },
    fileChanges: { enabled: true, optIn: false },
    gitActivity: { enabled: true, intervalMs: 300_000, optIn: false },
    terminalHistory: { enabled: false, intervalMs: 60_000, optIn: false },
    browserTabs: { enabled: false, intervalMs: 60_000, optIn: false },
    sessionHooks: { enabled: true, optIn: false },
    configChanges: { enabled: true, optIn: false },
    ...overrides,
  }
}

function makeOptions(
  overrides: Partial<ObservationManagerOptions> = {},
  factory?: ObserverFactory,
): ObservationManagerOptions {
  return {
    config: defaultConfig(overrides.config as Partial<ObservationConfig>),
    vaultRootDir: '/fake/vault',
    observerFactory: factory ?? createMockFactory(),
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────

describe('ObservationManager.getPlugins', () => {
  it('returns empty array before start', () => {
    const mgr = createObservationManager(makeOptions())
    expect(mgr.getPlugins()).toEqual([])
  })

  it('returns plugins after start', () => {
    const mgr = createObservationManager(makeOptions())
    mgr.start()

    const plugins = mgr.getPlugins()
    expect(plugins.length).toBeGreaterThan(0)
  })

  it('returns one plugin per created observer', () => {
    const mgr = createObservationManager(makeOptions())
    mgr.start()

    const status = mgr.getStatus()
    const plugins = mgr.getPlugins()

    expect(plugins.length).toBe(status.observers.length)
  })

  it('each plugin has metadata', () => {
    const mgr = createObservationManager(makeOptions())
    mgr.start()

    for (const plugin of mgr.getPlugins()) {
      expect(plugin.metadata).toBeDefined()
      expect(plugin.metadata.name).toBeTruthy()
      expect(plugin.metadata.version).toBeTruthy()
      expect(plugin.metadata.source).toBeTruthy()
    }
  })

  it('each plugin has capabilities', () => {
    const mgr = createObservationManager(makeOptions())
    mgr.start()

    for (const plugin of mgr.getPlugins()) {
      expect(plugin.capabilities).toBeDefined()
      expect(plugin.capabilities.length).toBeGreaterThan(0)
    }
  })

  it('plugins have correct state when running', () => {
    const mgr = createObservationManager(makeOptions())
    mgr.start()

    for (const plugin of mgr.getPlugins()) {
      expect(plugin.state).toBe('running')
    }
  })

  it('returns empty after stop (cleared)', () => {
    const mgr = createObservationManager(makeOptions())
    mgr.start()
    expect(mgr.getPlugins().length).toBeGreaterThan(0)

    mgr.stop()
    expect(mgr.getPlugins()).toEqual([])
  })

  it('plugins work correctly after restart', () => {
    const mgr = createObservationManager(makeOptions())
    mgr.start()
    mgr.stop()
    mgr.start()

    const plugins = mgr.getPlugins()
    expect(plugins.length).toBeGreaterThan(0)

    for (const plugin of mgr.getPlugins()) {
      expect(plugin.state).toBe('running')
    }
  })

  it('both file-change and config-change-observer plugins coexist', () => {
    const mgr = createObservationManager(makeOptions())
    mgr.start()

    const plugins = mgr.getPlugins()
    const names = plugins.map((p) => p.name)
    expect(names).toContain('file-change-observer')
    expect(names).toContain('config-change-observer')
  })

  it('plugin healthCheck returns healthy for running observer', async () => {
    const mgr = createObservationManager(makeOptions())
    mgr.start()

    const plugin = mgr.getPlugins()[0]!
    const health = await plugin.healthCheck()
    expect(health.healthy).toBe(true)
    expect(health.message).toBe('Running')
  })

  it('failed observer creation does not break plugin list', () => {
    const factory = createMockFactory({
      createActiveApp: () => {
        throw new Error('factory boom')
      },
    })
    const mgr = createObservationManager(makeOptions({}, factory))
    mgr.start()

    // Should still have other plugins
    const plugins = mgr.getPlugins()
    const names = plugins.map((p) => p.name)
    expect(names).not.toContain('active-app')
    expect(plugins.length).toBeGreaterThan(0)
  })

  it('backward compat: getObserver still returns Observer', () => {
    const mgr = createObservationManager(makeOptions())
    mgr.start()

    const obs = mgr.getObserver('active-app')
    expect(obs).toBeDefined()
    expect(obs!.type).toBe('active-app')
    expect(typeof obs!.start).toBe('function')
    expect(typeof obs!.stop).toBe('function')
    expect(typeof obs!.isRunning).toBe('function')
  })

  it('backward compat: getStatus still works', () => {
    const mgr = createObservationManager(makeOptions())
    mgr.start()

    const status = mgr.getStatus()
    expect(status.state).toBe('running')
    expect(status.observers.length).toBeGreaterThan(0)
    expect(status.startedAt).not.toBeNull()
  })
})

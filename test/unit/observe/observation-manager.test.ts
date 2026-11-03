import { describe, it, expect, vi } from 'vitest'
import type { Observer } from '../../../src/observe/observer.js'
import type { ObservationType, Observation, ObserverConfig } from '../../../src/observe/types.js'
import type { ObservationConfig } from '../../../src/observe/config.js'
import type { SessionEventData } from '../../../src/observe/observers/session-hooks.js'
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
): Observer & { startCalls: number; stopCalls: number } {
  let running = false
  const mock = {
    type: type as ObservationType,
    name,
    startCalls: 0,
    stopCalls: 0,
    start() {
      mock.startCalls++
      running = true
    },
    stop() {
      mock.stopCalls++
      running = false
    },
    isRunning() {
      return running
    },
    ...overrides,
  }
  return mock
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

describe('ObservationManager', () => {
  describe('Lifecycle', () => {
    it('start() creates and starts enabled observers', () => {
      const factory = createMockFactory()
      const createActiveApp = vi.fn(factory.createActiveApp)
      const createGitActivity = vi.fn(factory.createGitActivity)
      const createSessionHooks = vi.fn(factory.createSessionHooks)
      const spiedFactory = createMockFactory({
        createActiveApp,
        createGitActivity,
        createSessionHooks,
      })

      const mgr = createObservationManager(makeOptions({}, spiedFactory))
      mgr.start()

      expect(createActiveApp).toHaveBeenCalled()
      expect(createGitActivity).toHaveBeenCalled()
      expect(createSessionHooks).toHaveBeenCalled()
      expect(mgr.isRunning()).toBe(true)
    })

    it('start() skips disabled observers', () => {
      const createActiveApp = vi.fn(() => createMockObserver('active-app', 'active-app'))
      const factory = createMockFactory({ createActiveApp })

      const config = defaultConfig({
        activeApp: { enabled: false, optIn: false },
      })
      const mgr = createObservationManager(makeOptions({ config }, factory))
      mgr.start()

      expect(createActiveApp).not.toHaveBeenCalled()
    })

    it('stop() stops all running observers', () => {
      const tracked: { stopped: boolean }[] = []
      const factory = createMockFactory({
        createActiveApp: () => {
          const state = { stopped: false }
          tracked.push(state)
          return createMockObserver('active-app', 'active-app', {
            stop() {
              state.stopped = true
            },
          })
        },
        createSessionHooks: () => {
          const state = { stopped: false }
          tracked.push(state)
          const hook = createMockSessionHookObserver()
          hook.stop = () => {
            state.stopped = true
          }
          return hook
        },
      })

      const mgr = createObservationManager(makeOptions({}, factory))
      mgr.start()
      mgr.stop()

      expect(tracked.length).toBeGreaterThan(0)
      for (const s of tracked) {
        expect(s.stopped).toBe(true)
      }
      expect(mgr.isRunning()).toBe(false)
    })

    it('isRunning() returns true after start, false after stop', () => {
      const mgr = createObservationManager(makeOptions())
      expect(mgr.isRunning()).toBe(false)
      mgr.start()
      expect(mgr.isRunning()).toBe(true)
      mgr.stop()
      expect(mgr.isRunning()).toBe(false)
    })

    it('double start() is idempotent', () => {
      const createActiveApp = vi.fn(() => createMockObserver('active-app', 'active-app'))
      const factory = createMockFactory({ createActiveApp })

      const mgr = createObservationManager(makeOptions({}, factory))
      mgr.start()
      mgr.start()

      // Factory only called once — second start is no-op
      expect(createActiveApp).toHaveBeenCalledTimes(1)
    })

    it('double stop() is safe', () => {
      const mgr = createObservationManager(makeOptions())
      mgr.start()
      mgr.stop()
      expect(() => mgr.stop()).not.toThrow()
      expect(mgr.isRunning()).toBe(false)
    })
  })

  describe('Status', () => {
    it('getStatus() returns idle state before start', () => {
      const mgr = createObservationManager(makeOptions())
      const status = mgr.getStatus()

      expect(status.state).toBe('idle')
      expect(status.observers).toHaveLength(0)
      expect(status.startedAt).toBeNull()
      expect(status.observationCount).toBe(0)
    })

    it('getStatus() returns running state with observer details after start', () => {
      const mgr = createObservationManager(makeOptions())
      mgr.start()
      const status = mgr.getStatus()

      expect(status.state).toBe('running')
      expect(status.observers.length).toBeGreaterThan(0)
      for (const obs of status.observers) {
        expect(obs).toHaveProperty('name')
        expect(obs).toHaveProperty('type')
        expect(obs).toHaveProperty('running')
      }
    })

    it('getStatus() includes startedAt timestamp', () => {
      const mgr = createObservationManager(makeOptions())
      mgr.start()
      const status = mgr.getStatus()

      expect(status.startedAt).not.toBeNull()
      // Should be a valid ISO timestamp
      expect(new Date(status.startedAt!).toISOString()).toBe(status.startedAt)
    })

    it('getStatus() shows which observers are running vs not', () => {
      const config = defaultConfig({
        activeApp: { enabled: true, optIn: false },
        fileChanges: { enabled: false, optIn: false },
      })
      const mgr = createObservationManager(makeOptions({ config }))
      mgr.start()
      const status = mgr.getStatus()

      const activeApp = status.observers.find((o) => o.type === 'active-app')
      expect(activeApp?.running).toBe(true)

      // file-change observer should not be present since it's disabled
      const fileChange = status.observers.find((o) => o.name === 'file-change-observer')
      expect(fileChange).toBeUndefined()
    })
  })

  describe('Observer Creation', () => {
    it('active app observer created when enabled', () => {
      const createActiveApp = vi.fn(() => createMockObserver('active-app', 'active-app'))
      const factory = createMockFactory({ createActiveApp })

      const config = defaultConfig({ activeApp: { enabled: true, optIn: false } })
      const mgr = createObservationManager(makeOptions({ config }, factory))
      mgr.start()

      expect(createActiveApp).toHaveBeenCalled()
    })

    it('browser tab observer NOT created when optIn is false', () => {
      const createBrowserTabs = vi.fn(() => createMockObserver('browser-tab', 'browser-tab'))
      const factory = createMockFactory({ createBrowserTabs })

      const config = defaultConfig({
        browserTabs: { enabled: false, intervalMs: 60_000, optIn: false },
      })
      const mgr = createObservationManager(makeOptions({ config }, factory))
      mgr.start()

      expect(createBrowserTabs).not.toHaveBeenCalled()
    })

    it('terminal history observer NOT created when optIn is false', () => {
      const createTerminalHistory = vi.fn(() =>
        createMockObserver('terminal-history', 'terminal-history'),
      )
      const factory = createMockFactory({ createTerminalHistory })

      const config = defaultConfig({
        terminalHistory: { enabled: false, intervalMs: 60_000, optIn: false },
      })
      const mgr = createObservationManager(makeOptions({ config }, factory))
      mgr.start()

      expect(createTerminalHistory).not.toHaveBeenCalled()
    })

    it('file change observer created with configured directories', () => {
      const createFileChanges = vi.fn(() =>
        createMockObserver('file-change', 'file-change-observer'),
      )
      const factory = createMockFactory({ createFileChanges })

      const config = defaultConfig({
        fileChanges: { enabled: true, directories: ['/home/user/code'], optIn: false },
      })
      const mgr = createObservationManager(makeOptions({ config }, factory))
      mgr.start()

      expect(createFileChanges).toHaveBeenCalled()
    })

    it('git activity observer created with configured repos', () => {
      const createGitActivity = vi.fn(() =>
        createMockObserver('git-activity', 'git-activity-observer'),
      )
      const factory = createMockFactory({ createGitActivity })

      const config = defaultConfig({
        gitActivity: {
          enabled: true,
          repos: ['/home/user/repo'],
          intervalMs: 300_000,
          optIn: false,
        },
      })
      const mgr = createObservationManager(makeOptions({ config }, factory))
      mgr.start()

      expect(createGitActivity).toHaveBeenCalled()
    })

    it('session hook handler created when enabled', () => {
      const createSessionHooks = vi.fn(() => createMockSessionHookObserver())
      const factory = createMockFactory({ createSessionHooks })

      const config = defaultConfig({ sessionHooks: { enabled: true, optIn: false } })
      const mgr = createObservationManager(makeOptions({ config }, factory))
      mgr.start()

      expect(createSessionHooks).toHaveBeenCalled()
    })
  })

  describe('Configuration', () => {
    it('default config creates active-app, file-changes, git-activity, session-hooks', () => {
      const mgr = createObservationManager(makeOptions())
      mgr.start()
      const status = mgr.getStatus()

      const types = status.observers.map((o) => o.type)
      expect(types).toContain('active-app')
      expect(types).toContain('file-change')
      expect(types).toContain('git-activity')
      expect(types).toContain('session-hook')
      expect(types).not.toContain('browser-tab')
      expect(types).not.toContain('terminal-history')
    })

    it('privacy config passed to observer factory', () => {
      const createActiveApp = vi.fn(() => createMockObserver('active-app', 'active-app'))
      const factory = createMockFactory({ createActiveApp })

      const config = defaultConfig()
      config.privacy.excludeApps = ['Slack']

      const mgr = createObservationManager(makeOptions({ config }, factory))
      mgr.start()

      const callArgs = createActiveApp.mock.calls[0]![0] as Record<string, unknown>
      expect(callArgs).toHaveProperty('privacyFilter')
    })

    it('custom intervals passed to observers', () => {
      const createActiveApp = vi.fn(() => createMockObserver('active-app', 'active-app'))
      const factory = createMockFactory({ createActiveApp })

      const config = defaultConfig({
        activeApp: { enabled: true, intervalMs: 15_000, optIn: false },
      })
      const mgr = createObservationManager(makeOptions({ config }, factory))
      mgr.start()

      const callArgs = createActiveApp.mock.calls[0]![0] as Record<string, unknown>
      expect(callArgs).toHaveProperty('config')
      expect((callArgs['config'] as ObserverConfig).intervalMs).toBe(15_000)
    })
  })

  describe('Event Handling', () => {
    it('handleSessionEvent delegates to hook handler', () => {
      const hookObserver = createMockSessionHookObserver()
      const createSessionHooks = vi.fn(() => hookObserver)
      const factory = createMockFactory({ createSessionHooks })

      const mgr = createObservationManager(makeOptions({}, factory))
      mgr.start()

      const event: SessionEventData = {
        event: 'session-start',
        sessionId: 'sess-1',
        timestamp: new Date().toISOString(),
      }
      const result = mgr.handleSessionEvent(event)

      expect(hookObserver.handleEvent).toHaveBeenCalledWith(event)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('session-hook')
    })

    it('handleSessionEvent returns null if hooks disabled', () => {
      const config = defaultConfig({
        sessionHooks: { enabled: false, optIn: false },
      })
      const mgr = createObservationManager(makeOptions({ config }))
      mgr.start()

      const event: SessionEventData = {
        event: 'session-start',
        sessionId: 'sess-1',
        timestamp: new Date().toISOString(),
      }
      const result = mgr.handleSessionEvent(event)
      expect(result).toBeNull()
    })
  })

  describe('Error Handling', () => {
    it('failed observer start does not crash manager', () => {
      const factory = createMockFactory({
        createActiveApp: () => {
          const obs = createMockObserver('active-app', 'active-app', {
            start() {
              throw new Error('boom')
            },
          })
          return obs
        },
      })

      const mgr = createObservationManager(makeOptions({}, factory))
      expect(() => mgr.start()).not.toThrow()
      expect(mgr.isRunning()).toBe(true)
    })

    it('failed observer factory does not crash manager', () => {
      const factory = createMockFactory({
        createActiveApp: () => {
          throw new Error('factory boom')
        },
      })

      const mgr = createObservationManager(makeOptions({}, factory))
      expect(() => mgr.start()).not.toThrow()
      expect(mgr.isRunning()).toBe(true)
    })

    it('error observer state reflected in status', () => {
      let running = false
      const factory = createMockFactory({
        createActiveApp: () => ({
          type: 'active-app' as ObservationType,
          name: 'active-app',
          start() {
            running = false
          },
          stop() {
            running = false
          },
          isRunning() {
            return running
          },
        }),
      })

      const mgr = createObservationManager(makeOptions({}, factory))
      mgr.start()
      const status = mgr.getStatus()
      const aa = status.observers.find((o) => o.type === 'active-app')
      expect(aa?.running).toBe(false)
    })
  })

  describe('getObserver', () => {
    it('returns observer by type after start', () => {
      const mgr = createObservationManager(makeOptions())
      mgr.start()

      const obs = mgr.getObserver('active-app')
      expect(obs).toBeDefined()
      expect(obs!.type).toBe('active-app')
    })

    it('returns undefined for disabled observer type', () => {
      const config = defaultConfig({
        browserTabs: { enabled: false, optIn: false },
      })
      const mgr = createObservationManager(makeOptions({ config }))
      mgr.start()

      expect(mgr.getObserver('browser-tab')).toBeUndefined()
    })

    it('returns undefined before start', () => {
      const mgr = createObservationManager(makeOptions())
      expect(mgr.getObserver('active-app')).toBeUndefined()
    })
  })

  // ─── GAP-021: Observation query interface ─────────────────────
  describe('Observation Buffer (GAP-021)', () => {
    it('getObservations() returns empty array before any observations', () => {
      const mgr = createObservationManager(makeOptions())
      expect(mgr.getObservations()).toEqual([])
    })

    it('handleSessionEvent buffers observations for later query', () => {
      const hookObserver = createMockSessionHookObserver()
      const factory = createMockFactory({
        createSessionHooks: () => hookObserver,
      })
      const mgr = createObservationManager(makeOptions({}, factory))
      mgr.start()

      const event: SessionEventData = {
        event: 'session-start',
        sessionId: 'sess-1',
        timestamp: new Date().toISOString(),
      }
      mgr.handleSessionEvent(event)

      const observations = mgr.getObservations()
      expect(observations.length).toBe(1)
      expect(observations[0]!.type).toBe('session-hook')
    })

    it('recordObservation() adds observation to buffer', () => {
      const mgr = createObservationManager(makeOptions())
      mgr.start()

      const obs: Observation = {
        id: 'test-obs-1',
        type: 'active-app' as ObservationType,
        timestamp: new Date().toISOString(),
        source: 'VSCode',
        content: 'Active app: VSCode',
        tags: ['app:vscode'],
      }
      mgr.recordObservation(obs)

      const stored = mgr.getObservations()
      expect(stored.length).toBe(1)
      expect(stored[0]!.id).toBe('test-obs-1')
    })

    it('buffer respects max size and evicts oldest entries', () => {
      const mgr = createObservationManager(
        makeOptions({
          maxBufferSize: 3,
        }),
      )
      mgr.start()

      for (let i = 0; i < 5; i++) {
        mgr.recordObservation({
          id: `obs-${i}`,
          type: 'active-app' as ObservationType,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          source: 'VSCode',
          content: `Observation ${i}`,
          tags: [],
        })
      }

      const stored = mgr.getObservations()
      expect(stored.length).toBe(3)
      // Should have the 3 most recent (obs-2, obs-3, obs-4)
      expect(stored[0]!.id).toBe('obs-2')
      expect(stored[2]!.id).toBe('obs-4')
    })

    it('getObservations() returns a copy (immutable)', () => {
      const mgr = createObservationManager(makeOptions())
      mgr.start()

      mgr.recordObservation({
        id: 'obs-1',
        type: 'active-app' as ObservationType,
        timestamp: new Date().toISOString(),
        source: 'VSCode',
        content: 'test',
        tags: [],
      })

      const a = mgr.getObservations()
      const b = mgr.getObservations()
      expect(a).not.toBe(b) // different array references
      expect(a).toEqual(b) // same content
    })

    it('buffer persists across stop/start cycles', () => {
      const mgr = createObservationManager(makeOptions())
      mgr.start()

      mgr.recordObservation({
        id: 'obs-before-restart',
        type: 'active-app' as ObservationType,
        timestamp: new Date().toISOString(),
        source: 'VSCode',
        content: 'pre-restart',
        tags: [],
      })

      mgr.stop()
      mgr.start()

      const stored = mgr.getObservations()
      expect(stored.length).toBe(1)
      expect(stored[0]!.id).toBe('obs-before-restart')
    })
  })
})

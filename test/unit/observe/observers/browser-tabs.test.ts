import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBrowserTabObserver } from '../../../../src/observe/observers/browser-tabs.js'
import {
  createDarwinBrowserBackend,
  createLinuxBrowserBackend,
  createNoopBrowserBackend,
  createBrowserTabsBackend,
} from '../../../../src/observe/observers/browser-tabs-backends.js'
import type { CommandExecutor, CommandResult } from '../../../../src/observe/command-executor.js'
import { createDailyLogWriter } from '../../../../src/observe/daily-log-writer.js'
import { createPrivacyFilter } from '../../../../src/observe/privacy-filter.js'
import {
  ObservationType,
  type ObserverConfig,
  type PrivacyConfig,
} from '../../../../src/observe/types.js'

function mockLogWriter() {
  const entries: string[] = []
  const writer = {
    appendDailyLog: (entry: string) => {
      entries.push(entry)
    },
  }
  return { logWriter: createDailyLogWriter(writer), entries }
}

function defaultConfig(overrides: Partial<ObserverConfig> = {}): ObserverConfig {
  return { enabled: true, optIn: true, ...overrides }
}

function defaultPrivacy(overrides: Partial<PrivacyConfig> = {}): PrivacyConfig {
  return {
    excludeApps: [],
    excludePaths: [],
    excludeUrls: [],
    sanitizeSecrets: true,
    terminalHistoryOptIn: false,
    browserTabsOptIn: true,
    ...overrides,
  }
}

/** Create executor that maps commands to responses */
function createRoutingExecutor(
  routes: Record<string, CommandResult>,
  fallback: CommandResult = { stdout: '', stderr: '', exitCode: 1 },
): CommandExecutor {
  return {
    execute: async (command: string, args?: readonly string[]) => {
      const key = args ? `${command} ${args.join(' ')}` : command
      for (const [pattern, result] of Object.entries(routes)) {
        if (key.includes(pattern)) return result
      }
      return fallback
    },
  }
}

// ==========================================================================
// Backend unit tests
// ==========================================================================

describe('BrowserTabsBackend — Darwin', () => {
  it('returns tab info from osascript for running browser', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '1234\n', stderr: '', exitCode: 0 },
      'Google Chrome': { stdout: 'https://github.com, GitHub\n', stderr: '', exitCode: 0 },
    })
    const backend = createDarwinBrowserBackend()
    const tabs = await backend.poll(executor)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toEqual({
      browser: 'Google Chrome',
      title: 'GitHub',
      url: 'https://github.com',
    })
  })

  it('returns empty when no browsers running', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '', stderr: '', exitCode: 1 },
    })
    const backend = createDarwinBrowserBackend()
    expect(await backend.poll(executor)).toHaveLength(0)
  })

  it('handles osascript failure gracefully', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '1234\n', stderr: '', exitCode: 0 },
      'Google Chrome': { stdout: '', stderr: 'error', exitCode: 1 },
    })
    const backend = createDarwinBrowserBackend()
    expect(await backend.poll(executor)).toHaveLength(0)
  })
})

describe('BrowserTabsBackend — Linux', () => {
  it('extracts Chrome tab title from window name', async () => {
    const executor = createRoutingExecutor({
      xdotool: { stdout: 'GitHub - Pull Requests - Google Chrome\n', stderr: '', exitCode: 0 },
    })
    const backend = createLinuxBrowserBackend()
    const tabs = await backend.poll(executor)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toEqual({ browser: 'Google Chrome', title: 'GitHub - Pull Requests' })
  })

  it('extracts Firefox tab title from window name', async () => {
    const executor = createRoutingExecutor({
      xdotool: { stdout: 'MDN Web Docs — Mozilla Firefox\n', stderr: '', exitCode: 0 },
    })
    const backend = createLinuxBrowserBackend()
    const tabs = await backend.poll(executor)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toEqual({ browser: 'Mozilla Firefox', title: 'MDN Web Docs' })
  })

  it('extracts Brave tab title from window name', async () => {
    const executor = createRoutingExecutor({
      xdotool: { stdout: 'Search Results - Brave\n', stderr: '', exitCode: 0 },
    })
    const backend = createLinuxBrowserBackend()
    const tabs = await backend.poll(executor)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toEqual({ browser: 'Brave', title: 'Search Results' })
  })

  it('returns empty when active window is not a browser', async () => {
    const executor = createRoutingExecutor({
      xdotool: { stdout: 'main.ts — Visual Studio Code\n', stderr: '', exitCode: 0 },
    })
    const backend = createLinuxBrowserBackend()
    expect(await backend.poll(executor)).toHaveLength(0)
  })

  it('returns empty when xdotool is not installed', async () => {
    const executor = createRoutingExecutor({
      xdotool: { stdout: '', stderr: 'not found', exitCode: 127 },
    })
    const backend = createLinuxBrowserBackend()
    expect(await backend.poll(executor)).toHaveLength(0)
  })

  it('returns empty when window title is empty', async () => {
    const executor = createRoutingExecutor({
      xdotool: { stdout: '\n', stderr: '', exitCode: 0 },
    })
    const backend = createLinuxBrowserBackend()
    expect(await backend.poll(executor)).toHaveLength(0)
  })
})

describe('BrowserTabsBackend — Noop', () => {
  it('always returns empty array', async () => {
    const executor = createRoutingExecutor({})
    const backend = createNoopBrowserBackend()
    expect(await backend.poll(executor)).toHaveLength(0)
  })
})

describe('BrowserTabsBackend — Factory routing', () => {
  it('darwin routes to darwin backend', () => {
    const backend = createBrowserTabsBackend('darwin')
    expect(backend).toBeDefined()
  })

  it('linux routes to linux backend', () => {
    const backend = createBrowserTabsBackend('linux')
    expect(backend).toBeDefined()
  })

  it('wsl routes to noop backend', async () => {
    const backend = createBrowserTabsBackend('wsl')
    const executor = createRoutingExecutor({})
    expect(await backend.poll(executor)).toHaveLength(0)
  })

  it('win32 routes to noop backend', async () => {
    const backend = createBrowserTabsBackend('win32')
    const executor = createRoutingExecutor({})
    expect(await backend.poll(executor)).toHaveLength(0)
  })
})

// ==========================================================================
// Observer integration tests (platform-aware)
// ==========================================================================

describe('createBrowserTabObserver — platform routing', () => {
  it('uses linux backend when platform is linux', async () => {
    const executor = createRoutingExecutor({
      xdotool: { stdout: 'GitHub Issues - Google Chrome\n', stderr: '', exitCode: 0 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
      platform: 'linux',
    })
    const obs = await observer.poll()
    expect(obs).toHaveLength(1)
    expect(obs[0]!.source).toBe('Google Chrome')
    expect(obs[0]!.content).toBe('GitHub Issues')
  })

  it('linux backend omits url metadata', async () => {
    const executor = createRoutingExecutor({
      xdotool: { stdout: 'GitHub Issues - Google Chrome\n', stderr: '', exitCode: 0 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
      platform: 'linux',
    })
    const obs = await observer.poll()
    expect(obs[0]!.metadata).toBeUndefined()
  })

  it('returns empty on win32 (noop backend)', async () => {
    const executor = createRoutingExecutor({})
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
      platform: 'win32',
    })
    const obs = await observer.poll()
    expect(obs).toHaveLength(0)
  })
})

// ==========================================================================
// Original darwin-path tests (backward compatibility)
// ==========================================================================

describe('createBrowserTabObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('has correct type and name', () => {
    const executor = createRoutingExecutor({})
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    expect(observer.type).toBe(ObservationType.BrowserTab)
    expect(observer.name).toBe('browser-tab')
  })

  it('poll() returns observations for open Chrome tab', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '1234\n', stderr: '', exitCode: 0 },
      'Google Chrome': { stdout: 'https://github.com, GitHub\n', stderr: '', exitCode: 0 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs.length).toBeGreaterThan(0)
    expect(obs[0]!.type).toBe('browser-tab')
    expect(obs[0]!.source).toBe('Google Chrome')
    expect(obs[0]!.content).toBe('GitHub')
    expect(obs[0]!.metadata).toEqual({ url: 'https://github.com' })
  })

  it('poll() filters excluded URLs', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '1234\n', stderr: '', exitCode: 0 },
      'Google Chrome': {
        stdout: 'https://private.bank.com/account, Banking\n',
        stderr: '',
        exitCode: 0,
      },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({
      config: defaultPrivacy({ excludeUrls: ['**bank**'] }),
    })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs).toHaveLength(0)
  })

  it('poll() skips if optIn is false', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '1234\n', stderr: '', exitCode: 0 },
      'Google Chrome': { stdout: 'https://github.com, GitHub\n', stderr: '', exitCode: 0 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig({ optIn: false }),
    })
    const obs = await observer.poll()
    expect(obs).toHaveLength(0)
  })

  it('poll() handles no running browsers gracefully', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '', stderr: '', exitCode: 1 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs).toHaveLength(0)
  })

  it('poll() supports Safari osascript format', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '5678\n', stderr: '', exitCode: 0 },
      Safari: { stdout: 'https://apple.com, Apple\n', stderr: '', exitCode: 0 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    const safariObs = obs.filter((o) => o.source === 'Safari')
    expect(safariObs.length).toBeGreaterThan(0)
    expect(safariObs[0]!.metadata).toEqual({ url: 'https://apple.com' })
  })

  it('poll() deduplicates unchanged tabs', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '1234\n', stderr: '', exitCode: 0 },
      'Google Chrome': { stdout: 'https://github.com, GitHub\n', stderr: '', exitCode: 0 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const first = await observer.poll()
    const second = await observer.poll()
    expect(first.length).toBeGreaterThan(0)
    expect(second).toHaveLength(0)
  })

  it('poll() produces new observation when tab changes', async () => {
    let callCount = 0
    const executor: CommandExecutor = {
      execute: async (command: string, args?: readonly string[]) => {
        const key = args ? `${command} ${args.join(' ')}` : command
        if (key.includes('pgrep')) return { stdout: '1234\n', stderr: '', exitCode: 0 }
        if (key.includes('Google Chrome')) {
          callCount++
          if (callCount <= 1)
            return { stdout: 'https://github.com, GitHub\n', stderr: '', exitCode: 0 }
          return { stdout: 'https://docs.github.com, Docs\n', stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 1 }
      },
    }
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const first = await observer.poll()
    const second = await observer.poll()
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(second[0]!.content).toBe('Docs')
  })

  it('start() begins polling only if optIn', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '1234\n', stderr: '', exitCode: 0 },
      'Google Chrome': { stdout: 'https://github.com, GitHub\n', stderr: '', exitCode: 0 },
    })
    const { logWriter, entries } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
      intervalMs: 5000,
      // Explicit platform: start() gates on platform support, and this test
      // must exercise the polling loop deterministically on every host OS.
      platform: 'darwin',
    })
    observer.start()
    expect(observer.isRunning()).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(entries.length).toBeGreaterThan(0)
    observer.stop()
  })

  it('start() is no-op when optIn is false', () => {
    const executor = createRoutingExecutor({})
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig({ optIn: false }),
    })
    observer.start()
    expect(observer.isRunning()).toBe(false)
  })

  it('stop() clears interval', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '1234\n', stderr: '', exitCode: 0 },
      'Google Chrome': { stdout: 'https://github.com, GitHub\n', stderr: '', exitCode: 0 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
      intervalMs: 5000,
    })
    observer.start()
    observer.stop()
    expect(observer.isRunning()).toBe(false)
  })

  it('isRunning() returns false when not opted in', () => {
    const executor = createRoutingExecutor({})
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig({ optIn: false }),
    })
    expect(observer.isRunning()).toBe(false)
  })

  it('osascript failure handled gracefully', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '1234\n', stderr: '', exitCode: 0 },
      'Google Chrome': { stdout: '', stderr: 'error', exitCode: 1 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs).toHaveLength(0)
  })

  it('tags include browser name', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '1234\n', stderr: '', exitCode: 0 },
      'Google Chrome': { stdout: 'https://github.com, GitHub\n', stderr: '', exitCode: 0 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs[0]!.tags).toContain('type:browser-tab')
    expect(obs[0]!.tags).toContain('source:google chrome')
  })

  it('writes observations to logWriter', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '1234\n', stderr: '', exitCode: 0 },
      'Google Chrome': { stdout: 'https://github.com, GitHub\n', stderr: '', exitCode: 0 },
    })
    const { logWriter, entries } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    await observer.poll()
    expect(entries.length).toBeGreaterThan(0)
  })

  it('observation has valid id and timestamp', async () => {
    const executor = createRoutingExecutor({
      pgrep: { stdout: '1234\n', stderr: '', exitCode: 0 },
      'Google Chrome': { stdout: 'https://github.com, GitHub\n', stderr: '', exitCode: 0 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createBrowserTabObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(obs[0]!.timestamp).toBeTruthy()
  })
})

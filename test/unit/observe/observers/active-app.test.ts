import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createActiveAppObserver } from '../../../../src/observe/observers/active-app.js'
import {
  createDarwinBackend,
  createLinuxBackend,
  createWslBackend,
  createNoopBackend,
  createActiveAppBackend,
} from '../../../../src/observe/observers/active-app-backends.js'
import type { CommandExecutor, CommandResult } from '../../../../src/observe/command-executor.js'
import { createDailyLogWriter } from '../../../../src/observe/daily-log-writer.js'
import { createPrivacyFilter } from '../../../../src/observe/privacy-filter.js'
import {
  ObservationType,
  type ObserverConfig,
  type PrivacyConfig,
} from '../../../../src/observe/types.js'

function mockExecutor(responses: CommandResult[]): CommandExecutor {
  let callIndex = 0
  return {
    execute: async () => {
      const result = responses[callIndex % responses.length]!
      callIndex++
      return result
    },
  }
}

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
  return { enabled: true, optIn: false, ...overrides }
}

function defaultPrivacy(overrides: Partial<PrivacyConfig> = {}): PrivacyConfig {
  return {
    excludeApps: [],
    excludePaths: [],
    excludeUrls: [],
    sanitizeSecrets: true,
    terminalHistoryOptIn: false,
    browserTabsOptIn: false,
    ...overrides,
  }
}

// ==========================================================================
// Backend unit tests
// ==========================================================================

describe('ActiveAppBackend — Darwin', () => {
  it('returns app name and window title from osascript', async () => {
    const executor = mockExecutor([
      { stdout: 'Code\n', stderr: '', exitCode: 0 },
      { stdout: 'main.ts — scns\n', stderr: '', exitCode: 0 },
    ])
    const backend = createDarwinBackend()
    const info = await backend.poll(executor)
    expect(info).toEqual({ appName: 'Code', windowTitle: 'main.ts — scns' })
  })

  it('returns null when osascript fails', async () => {
    const executor = mockExecutor([{ stdout: '', stderr: 'error', exitCode: 1 }])
    const backend = createDarwinBackend()
    expect(await backend.poll(executor)).toBeNull()
  })

  it('returns empty window title when title script fails', async () => {
    const executor = mockExecutor([
      { stdout: 'Code\n', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'no window', exitCode: 1 },
    ])
    const backend = createDarwinBackend()
    const info = await backend.poll(executor)
    expect(info).toEqual({ appName: 'Code', windowTitle: '' })
  })
})

describe('ActiveAppBackend — Linux', () => {
  it('returns app name from /proc and window title from xdotool', async () => {
    const executor = createRoutingExecutor({
      'xdotool getactivewindow getwindowname': {
        stdout: 'main.ts — Code\n',
        stderr: '',
        exitCode: 0,
      },
      'xdotool getactivewindow getwindowpid': { stdout: '12345\n', stderr: '', exitCode: 0 },
      'cat /proc/12345/comm': { stdout: 'code\n', stderr: '', exitCode: 0 },
    })
    const backend = createLinuxBackend()
    const info = await backend.poll(executor)
    expect(info).toEqual({ appName: 'code', windowTitle: 'main.ts — Code' })
  })

  it('falls back to window title as app name when /proc read fails', async () => {
    const executor = createRoutingExecutor({
      'xdotool getactivewindow getwindowname': { stdout: 'Terminal\n', stderr: '', exitCode: 0 },
      'xdotool getactivewindow getwindowpid': { stdout: '999\n', stderr: '', exitCode: 0 },
      'cat /proc/999/comm': { stdout: '', stderr: 'not found', exitCode: 1 },
    })
    const backend = createLinuxBackend()
    const info = await backend.poll(executor)
    expect(info).toEqual({ appName: 'Terminal', windowTitle: 'Terminal' })
  })

  it('returns null when xdotool is not installed', async () => {
    const executor = createRoutingExecutor({
      xdotool: { stdout: '', stderr: 'not found', exitCode: 127 },
    })
    const backend = createLinuxBackend()
    expect(await backend.poll(executor)).toBeNull()
  })

  it('returns null when window title is empty', async () => {
    const executor = createRoutingExecutor({
      'xdotool getactivewindow getwindowname': { stdout: '\n', stderr: '', exitCode: 0 },
    })
    const backend = createLinuxBackend()
    expect(await backend.poll(executor)).toBeNull()
  })
})

describe('ActiveAppBackend — WSL', () => {
  it('returns app name and title from powershell.exe', async () => {
    let callCount = 0
    const executor: CommandExecutor = {
      execute: async () => {
        callCount++
        if (callCount === 1) return { stdout: 'chrome\n', stderr: '', exitCode: 0 }
        return { stdout: 'GitHub - Google Chrome\n', stderr: '', exitCode: 0 }
      },
    }
    const backend = createWslBackend()
    const info = await backend.poll(executor)
    expect(info).toEqual({ appName: 'chrome', windowTitle: 'GitHub - Google Chrome' })
  })

  it('returns null when powershell.exe fails', async () => {
    const executor = mockExecutor([{ stdout: '', stderr: 'not found', exitCode: 1 }])
    const backend = createWslBackend()
    expect(await backend.poll(executor)).toBeNull()
  })

  it('returns null when powershell returns empty output', async () => {
    const executor = mockExecutor([{ stdout: '\n', stderr: '', exitCode: 0 }])
    const backend = createWslBackend()
    expect(await backend.poll(executor)).toBeNull()
  })
})

describe('ActiveAppBackend — Noop', () => {
  it('always returns null', async () => {
    const executor = mockExecutor([])
    const backend = createNoopBackend()
    expect(await backend.poll(executor)).toBeNull()
  })
})

describe('ActiveAppBackend — Factory routing', () => {
  it('darwin routes to darwin backend', () => {
    const backend = createActiveAppBackend('darwin')
    expect(backend).toBeDefined()
  })

  it('linux routes to linux backend', () => {
    const backend = createActiveAppBackend('linux')
    expect(backend).toBeDefined()
  })

  it('wsl routes to wsl backend', () => {
    const backend = createActiveAppBackend('wsl')
    expect(backend).toBeDefined()
  })

  it('win32 routes to noop backend', async () => {
    const backend = createActiveAppBackend('win32')
    const executor = mockExecutor([])
    expect(await backend.poll(executor)).toBeNull()
  })
})

// ==========================================================================
// Observer integration tests (platform-aware)
// ==========================================================================

describe('createActiveAppObserver — platform routing', () => {
  it('uses linux backend when platform is linux', async () => {
    const executor = createRoutingExecutor({
      'xdotool getactivewindow getwindowname': { stdout: 'Terminal\n', stderr: '', exitCode: 0 },
      'xdotool getactivewindow getwindowpid': { stdout: '100\n', stderr: '', exitCode: 0 },
      'cat /proc/100/comm': { stdout: 'gnome-terminal\n', stderr: '', exitCode: 0 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
      platform: 'linux',
    })
    const obs = await observer.poll()
    expect(obs).not.toBeNull()
    expect(obs!.source).toBe('gnome-terminal')
    expect(obs!.content).toBe('Terminal')
  })

  it('privacy filter works with linux backend', async () => {
    const executor = createRoutingExecutor({
      'xdotool getactivewindow getwindowname': { stdout: 'Chat\n', stderr: '', exitCode: 0 },
      'xdotool getactivewindow getwindowpid': { stdout: '100\n', stderr: '', exitCode: 0 },
      'cat /proc/100/comm': { stdout: 'slack\n', stderr: '', exitCode: 0 },
    })
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({
      config: defaultPrivacy({ excludeApps: ['slack'] }),
    })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
      platform: 'linux',
    })
    const obs = await observer.poll()
    expect(obs).toBeNull()
  })

  it('returns null on win32 (noop backend)', async () => {
    const executor = mockExecutor([])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
      platform: 'win32',
    })
    const obs = await observer.poll()
    expect(obs).toBeNull()
  })
})

// ==========================================================================
// Original darwin-path tests (backward compatibility)
// ==========================================================================

describe('createActiveAppObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('has correct type and name', () => {
    const executor = mockExecutor([{ stdout: '', stderr: '', exitCode: 0 }])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    expect(observer.type).toBe(ObservationType.ActiveApp)
    expect(observer.name).toBe('active-app')
  })

  it('poll() returns Observation for active app', async () => {
    const executor = mockExecutor([
      { stdout: 'Code\n', stderr: '', exitCode: 0 },
      { stdout: 'main.ts — scns\n', stderr: '', exitCode: 0 },
    ])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs).not.toBeNull()
    expect(obs!.type).toBe('active-app')
    expect(obs!.source).toBe('Code')
    expect(obs!.content).toContain('main.ts')
  })

  it('poll() returns null when app is unchanged', async () => {
    const executor = mockExecutor([
      { stdout: 'Code\n', stderr: '', exitCode: 0 },
      { stdout: 'main.ts\n', stderr: '', exitCode: 0 },
    ])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const first = await observer.poll()
    expect(first).not.toBeNull()
    const second = await observer.poll()
    expect(second).toBeNull()
  })

  it('poll() returns null when app is excluded by privacy filter', async () => {
    const executor = mockExecutor([
      { stdout: 'Slack\n', stderr: '', exitCode: 0 },
      { stdout: 'General\n', stderr: '', exitCode: 0 },
    ])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({
      config: defaultPrivacy({ excludeApps: ['Slack'] }),
    })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs).toBeNull()
  })

  it('poll() handles osascript failure gracefully', async () => {
    const executor = mockExecutor([{ stdout: '', stderr: 'error', exitCode: 1 }])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs).toBeNull()
  })

  it('poll() handles empty stdout gracefully', async () => {
    const executor = mockExecutor([{ stdout: '', stderr: '', exitCode: 0 }])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs).toBeNull()
  })

  it('poll() writes observation to logWriter', async () => {
    const executor = mockExecutor([
      { stdout: 'Code\n', stderr: '', exitCode: 0 },
      { stdout: 'main.ts\n', stderr: '', exitCode: 0 },
    ])
    const { logWriter, entries } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    await observer.poll()
    expect(entries.length).toBeGreaterThan(0)
  })

  it('window title included in content', async () => {
    const executor = mockExecutor([
      { stdout: 'Firefox\n', stderr: '', exitCode: 0 },
      { stdout: 'GitHub - SCNS\n', stderr: '', exitCode: 0 },
    ])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs!.content).toBe('GitHub - SCNS')
  })

  it('tags include app name and type', async () => {
    const executor = mockExecutor([
      { stdout: 'Code\n', stderr: '', exitCode: 0 },
      { stdout: 'editor\n', stderr: '', exitCode: 0 },
    ])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs!.tags).toContain('type:active-app')
    expect(obs!.tags).toContain('source:code')
  })

  it('multiple polls with app changes produce observations', async () => {
    let callCount = 0
    const responses: CommandResult[] = [
      { stdout: 'Code\n', stderr: '', exitCode: 0 },
      { stdout: 'editor\n', stderr: '', exitCode: 0 },
      { stdout: 'Firefox\n', stderr: '', exitCode: 0 },
      { stdout: 'github.com\n', stderr: '', exitCode: 0 },
    ]
    const executor: CommandExecutor = {
      execute: async () => {
        const r = responses[callCount % responses.length]!
        callCount++
        return r
      },
    }
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const first = await observer.poll()
    const second = await observer.poll()
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first!.source).toBe('Code')
    expect(second!.source).toBe('Firefox')
  })

  it('getLastApp() returns null initially', () => {
    const executor = mockExecutor([{ stdout: '', stderr: '', exitCode: 0 }])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    expect(observer.getLastApp()).toBeNull()
  })

  it('getLastApp() returns last app after poll', async () => {
    const executor = mockExecutor([
      { stdout: 'Code\n', stderr: '', exitCode: 0 },
      { stdout: 'editor\n', stderr: '', exitCode: 0 },
    ])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    await observer.poll()
    expect(observer.getLastApp()).toBe('Code')
  })

  it('start() begins polling interval', async () => {
    const executor = mockExecutor([
      { stdout: 'Code\n', stderr: '', exitCode: 0 },
      { stdout: 'editor\n', stderr: '', exitCode: 0 },
    ])
    const { logWriter, entries } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
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

  it('stop() clears interval and sets idle state', async () => {
    const executor = mockExecutor([
      { stdout: 'Code\n', stderr: '', exitCode: 0 },
      { stdout: 'editor\n', stderr: '', exitCode: 0 },
    ])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
      intervalMs: 5000,
      platform: 'darwin',
    })
    observer.start()
    expect(observer.isRunning()).toBe(true)
    observer.stop()
    expect(observer.isRunning()).toBe(false)
  })

  it('isRunning() returns false before start', () => {
    const executor = mockExecutor([{ stdout: '', stderr: '', exitCode: 0 }])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    expect(observer.isRunning()).toBe(false)
  })

  it('observation has valid id and timestamp', async () => {
    const executor = mockExecutor([
      { stdout: 'Code\n', stderr: '', exitCode: 0 },
      { stdout: 'editor\n', stderr: '', exitCode: 0 },
    ])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(obs!.timestamp).toBeTruthy()
  })

  it('poll() handles window title failure gracefully', async () => {
    let callCount = 0
    const executor: CommandExecutor = {
      execute: async () => {
        callCount++
        if (callCount === 1) return { stdout: 'Code\n', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: 'no window', exitCode: 1 }
      },
    }
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig(),
    })
    const obs = await observer.poll()
    expect(obs).not.toBeNull()
    expect(obs!.source).toBe('Code')
    expect(obs!.content).toBe('')
  })

  it('start() is no-op when config.enabled is false', () => {
    const executor = mockExecutor([{ stdout: '', stderr: '', exitCode: 0 }])
    const { logWriter } = mockLogWriter()
    const privacyFilter = createPrivacyFilter({ config: defaultPrivacy() })
    const observer = createActiveAppObserver({
      executor,
      logWriter,
      privacyFilter,
      config: defaultConfig({ enabled: false }),
    })
    observer.start()
    expect(observer.isRunning()).toBe(false)
  })
})

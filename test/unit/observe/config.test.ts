import { describe, it, expect, afterEach } from 'vitest'
import { loadObservationConfig, ObservationConfigSchema } from '../../../src/observe/config.js'

describe('ObservationConfigSchema', () => {
  it('provides defaults for empty input', () => {
    const config = ObservationConfigSchema.parse({})
    expect(config.privacy.sanitizeSecrets).toBe(true)
    expect(config.activeApp.enabled).toBe(true)
    expect(config.activeApp.intervalMs).toBe(30_000)
    expect(config.fileChanges.enabled).toBe(true)
    expect(config.gitActivity.enabled).toBe(true)
    expect(config.gitActivity.intervalMs).toBe(300_000)
    expect(config.terminalHistory.enabled).toBe(false)
    expect(config.terminalHistory.optIn).toBe(false)
    expect(config.browserTabs.enabled).toBe(false)
    expect(config.browserTabs.optIn).toBe(false)
    expect(config.sessionHooks.enabled).toBe(true)
  })
})

describe('loadObservationConfig', () => {
  const savedEnv: Record<string, string | undefined> = {}

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key]
    }
  })

  it('returns defaults when no env vars set', () => {
    const config = loadObservationConfig()
    expect(config.activeApp.enabled).toBe(true)
    expect(config.activeApp.intervalMs).toBe(30_000)
    expect(config.fileChanges.enabled).toBe(true)
    expect(config.gitActivity.enabled).toBe(true)
    expect(config.terminalHistory.enabled).toBe(false)
    expect(config.browserTabs.enabled).toBe(false)
    expect(config.sessionHooks.enabled).toBe(true)
    expect(config.privacy.excludeApps).toEqual([])
    expect(config.privacy.excludePaths).toEqual([])
    expect(config.privacy.excludeUrls).toEqual([])
  })

  it('reads OBSERVE_ACTIVE_APP_ENABLED=false', () => {
    setEnv('OBSERVE_ACTIVE_APP_ENABLED', 'false')
    const config = loadObservationConfig()
    expect(config.activeApp.enabled).toBe(false)
  })

  it('reads OBSERVE_ACTIVE_APP_ENABLED=true', () => {
    setEnv('OBSERVE_ACTIVE_APP_ENABLED', 'true')
    const config = loadObservationConfig()
    expect(config.activeApp.enabled).toBe(true)
  })

  it('reads OBSERVE_ACTIVE_APP_INTERVAL_MS', () => {
    setEnv('OBSERVE_ACTIVE_APP_INTERVAL_MS', '15000')
    const config = loadObservationConfig()
    expect(config.activeApp.intervalMs).toBe(15_000)
  })

  it('falls back to default for invalid interval', () => {
    setEnv('OBSERVE_ACTIVE_APP_INTERVAL_MS', 'not-a-number')
    const config = loadObservationConfig()
    expect(config.activeApp.intervalMs).toBe(30_000)
  })

  it('reads OBSERVE_FILE_DIRS as comma-separated paths', () => {
    setEnv('OBSERVE_FILE_DIRS', '/home/user/project,/home/user/other')
    const config = loadObservationConfig()
    expect(config.fileChanges.directories).toEqual(['/home/user/project', '/home/user/other'])
  })

  it('reads OBSERVE_GIT_REPOS as comma-separated paths', () => {
    setEnv('OBSERVE_GIT_REPOS', '/repo1,/repo2,/repo3')
    const config = loadObservationConfig()
    expect(config.gitActivity.repos).toEqual(['/repo1', '/repo2', '/repo3'])
  })

  it('reads OBSERVE_TERMINAL_OPT_IN boolean', () => {
    setEnv('OBSERVE_TERMINAL_OPT_IN', 'true')
    const config = loadObservationConfig()
    expect(config.terminalHistory.optIn).toBe(true)
    expect(config.terminalHistory.enabled).toBe(true)
  })

  it('reads OBSERVE_BROWSER_OPT_IN boolean', () => {
    setEnv('OBSERVE_BROWSER_OPT_IN', 'true')
    const config = loadObservationConfig()
    expect(config.browserTabs.optIn).toBe(true)
    expect(config.browserTabs.enabled).toBe(true)
  })

  it('reads OBSERVE_EXCLUDE_APPS as comma-separated globs', () => {
    setEnv('OBSERVE_EXCLUDE_APPS', '1Password,Keychain*')
    const config = loadObservationConfig()
    expect(config.privacy.excludeApps).toEqual(['1Password', 'Keychain*'])
  })

  it('reads OBSERVE_EXCLUDE_PATHS as comma-separated globs', () => {
    setEnv('OBSERVE_EXCLUDE_PATHS', '**/.env,**/secrets/**')
    const config = loadObservationConfig()
    expect(config.privacy.excludePaths).toEqual(['**/.env', '**/secrets/**'])
  })

  it('reads OBSERVE_EXCLUDE_URLS as comma-separated globs', () => {
    setEnv('OBSERVE_EXCLUDE_URLS', '*bank*,*password*')
    const config = loadObservationConfig()
    expect(config.privacy.excludeUrls).toEqual(['*bank*', '*password*'])
  })

  it('accepts 1/0 as boolean values', () => {
    setEnv('OBSERVE_TERMINAL_OPT_IN', '1')
    setEnv('OBSERVE_BROWSER_OPT_IN', '0')
    const config = loadObservationConfig()
    expect(config.terminalHistory.optIn).toBe(true)
    expect(config.browserTabs.optIn).toBe(false)
  })

  it('reads OBSERVE_GIT_INTERVAL_MS', () => {
    setEnv('OBSERVE_GIT_INTERVAL_MS', '600000')
    const config = loadObservationConfig()
    expect(config.gitActivity.intervalMs).toBe(600_000)
  })

  it('reads OBSERVE_TERMINAL_INTERVAL_MS', () => {
    setEnv('OBSERVE_TERMINAL_INTERVAL_MS', '120000')
    const config = loadObservationConfig()
    expect(config.terminalHistory.intervalMs).toBe(120_000)
  })

  it('reads OBSERVE_BROWSER_INTERVAL_MS', () => {
    setEnv('OBSERVE_BROWSER_INTERVAL_MS', '120000')
    const config = loadObservationConfig()
    expect(config.browserTabs.intervalMs).toBe(120_000)
  })

  it('handles empty comma-separated values', () => {
    setEnv('OBSERVE_FILE_DIRS', '')
    const config = loadObservationConfig()
    expect(config.fileChanges.directories).toBeUndefined()
  })

  it('returns frozen config', () => {
    const config = loadObservationConfig()
    expect(Object.isFrozen(config)).toBe(true)
  })
})

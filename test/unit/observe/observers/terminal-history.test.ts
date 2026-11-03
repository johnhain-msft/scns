import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createTerminalHistoryObserver,
  type FileStatReader,
  type TerminalHistoryObserverOptions,
} from '../../../../src/observe/observers/terminal-history.js'
import { createSecretSanitizer } from '../../../../src/observe/secret-sanitizer.js'
import { createDailyLogWriter } from '../../../../src/observe/daily-log-writer.js'
import { createPrivacyFilter } from '../../../../src/observe/privacy-filter.js'
import type { ObserverConfig, PrivacyConfig } from '../../../../src/observe/types.js'

function createMockFileReader(
  files: Record<string, { mtimeMs: number; lines: string[] }> = {},
): FileStatReader {
  return {
    stat(path: string) {
      const f = files[path]
      return f ? { mtimeMs: f.mtimeMs } : null
    },
    readLines(path: string, fromLine: number) {
      const f = files[path]
      if (!f) return []
      return f.lines.slice(fromLine)
    },
    lineCount(path: string) {
      const f = files[path]
      return f ? f.lines.length : 0
    },
  }
}

function makeOptions(
  overrides: Partial<TerminalHistoryObserverOptions> = {},
): TerminalHistoryObserverOptions {
  const privacyConfig: PrivacyConfig = {
    excludeApps: [],
    excludePaths: [],
    excludeUrls: [],
    sanitizeSecrets: true,
    terminalHistoryOptIn: true,
    browserTabsOptIn: false,
  }
  const config: ObserverConfig = { enabled: true, optIn: true }

  return {
    sanitizer: createSecretSanitizer(),
    logWriter: createDailyLogWriter({ appendDailyLog: vi.fn() }),
    privacyFilter: createPrivacyFilter({ config: privacyConfig }),
    config,
    intervalMs: 60_000,
    historyPaths: ['/home/user/.zsh_history'],
    ...overrides,
  }
}

describe('TerminalHistoryObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('has correct type and name', () => {
    const observer = createTerminalHistoryObserver(
      makeOptions({
        fileReader: createMockFileReader(),
      }),
    )
    expect(observer.type).toBe('terminal-history')
    expect(observer.name).toBe('terminal-history')
  })

  it('poll() returns observations for new history lines', async () => {
    const reader = createMockFileReader({
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: ['git status', 'npm test', 'vim file.ts'],
      },
    })
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    const observations = await observer.poll()
    expect(observations).toHaveLength(1)
    expect(observations[0]!.type).toBe('terminal-history')
    expect(observations[0]!.content).toContain('git status')
    expect(observations[0]!.content).toContain('npm test')
    expect(observations[0]!.content).toContain('vim file.ts')
  })

  it('poll() skips when mtime unchanged', async () => {
    const reader = createMockFileReader({
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: ['git status'],
      },
    })
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    const first = await observer.poll()
    expect(first).toHaveLength(1)

    // mtime unchanged — should skip
    const second = await observer.poll()
    expect(second).toHaveLength(0)
  })

  it('poll() sanitizes secrets from history lines', async () => {
    const reader = createMockFileReader({
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: ['export SECRET_KEY=sk-abcdefghijklmnopqrstuvwxyz12345678'],
      },
    })
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    const observations = await observer.poll()
    expect(observations).toHaveLength(1)
    expect(observations[0]!.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz12345678')
    expect(observations[0]!.content).toContain('[REDACTED]')
  })

  it('poll() skips empty/whitespace-only lines', async () => {
    const reader = createMockFileReader({
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: ['git status', '', '   ', 'npm run build'],
      },
    })
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    const observations = await observer.poll()
    expect(observations).toHaveLength(1)
    const content = observations[0]!.content
    expect(content).toContain('git status')
    expect(content).toContain('npm run build')
    // Should not have blank entries
    const lines = content.split('\n').filter((l: string) => l.trim().length > 0)
    expect(lines).toHaveLength(2)
  })

  it('poll() skips common harmless commands (ls, cd, pwd, clear)', async () => {
    const reader = createMockFileReader({
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: ['ls', 'cd', 'pwd', 'clear', 'npm test'],
      },
    })
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    const observations = await observer.poll()
    expect(observations).toHaveLength(1)
    const content = observations[0]!.content
    expect(content).not.toContain('ls')
    expect(content).not.toMatch(/\bcd\b/)
    expect(content).not.toContain('pwd')
    expect(content).not.toContain('clear')
    expect(content).toContain('npm test')
  })

  it('poll() batches lines into single observation (max 50)', async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `command-${i}`)
    const reader = createMockFileReader({
      '/home/user/.zsh_history': { mtimeMs: 1000, lines },
    })
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    const observations = await observer.poll()
    // 80 lines → batched at max 50 per observation → 2 observations
    expect(observations).toHaveLength(2)
    const firstContent = observations[0]!.content.split('\n')
    expect(firstContent).toHaveLength(50)
    const secondContent = observations[1]!.content.split('\n')
    expect(secondContent).toHaveLength(30)
  })

  it('poll() reads incrementally (only new lines since last poll)', async () => {
    const files: Record<string, { mtimeMs: number; lines: string[] }> = {
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: ['git status', 'npm test'],
      },
    }
    const reader = createMockFileReader(files)
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    const first = await observer.poll()
    expect(first).toHaveLength(1)

    // Simulate new lines added
    files['/home/user/.zsh_history'] = {
      mtimeMs: 2000,
      lines: ['git status', 'npm test', 'vitest run'],
    }

    const second = await observer.poll()
    expect(second).toHaveLength(1)
    expect(second[0]!.content).toContain('vitest run')
    expect(second[0]!.content).not.toContain('git status')
  })

  it('poll() handles missing history file gracefully', async () => {
    const reader = createMockFileReader({})
    const observer = createTerminalHistoryObserver(
      makeOptions({
        fileReader: reader,
        historyPaths: ['/nonexistent/.zsh_history'],
      }),
    )

    const observations = await observer.poll()
    expect(observations).toHaveLength(0)
  })

  it('start() begins polling (only if optIn)', () => {
    const reader = createMockFileReader({})
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    observer.start()
    expect(observer.isRunning()).toBe(true)
    observer.stop()
  })

  it('start() is no-op when optIn is false', () => {
    const privacyConfig: PrivacyConfig = {
      excludeApps: [],
      excludePaths: [],
      excludeUrls: [],
      sanitizeSecrets: true,
      terminalHistoryOptIn: false,
      browserTabsOptIn: false,
    }
    const reader = createMockFileReader({})
    const observer = createTerminalHistoryObserver(
      makeOptions({
        fileReader: reader,
        privacyFilter: createPrivacyFilter({ config: privacyConfig }),
        config: { enabled: true, optIn: false },
      }),
    )

    observer.start()
    expect(observer.isRunning()).toBe(false)
  })

  it('stop() clears interval', () => {
    const reader = createMockFileReader({})
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    observer.start()
    expect(observer.isRunning()).toBe(true)
    observer.stop()
    expect(observer.isRunning()).toBe(false)
  })

  it('isRunning() reflects state', () => {
    const reader = createMockFileReader({})
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    expect(observer.isRunning()).toBe(false)
    observer.start()
    expect(observer.isRunning()).toBe(true)
    observer.stop()
    expect(observer.isRunning()).toBe(false)
  })

  it('tracks multiple history files simultaneously', async () => {
    const reader = createMockFileReader({
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: ['zsh-command'],
      },
      '/home/user/.bash_history': {
        mtimeMs: 1000,
        lines: ['bash-command'],
      },
    })
    const observer = createTerminalHistoryObserver(
      makeOptions({
        fileReader: reader,
        historyPaths: ['/home/user/.zsh_history', '/home/user/.bash_history'],
      }),
    )

    const observations = await observer.poll()
    expect(observations).toHaveLength(2)
    const sources = observations.map((o) => o.source)
    expect(sources).toContain('zsh')
    expect(sources).toContain('bash')
  })

  it('source identifies shell type (zsh vs bash)', async () => {
    const reader = createMockFileReader({
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: ['zsh-command'],
      },
    })
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    const observations = await observer.poll()
    expect(observations[0]!.source).toBe('zsh')
  })

  it('tags include shell type', async () => {
    const reader = createMockFileReader({
      '/home/user/.bash_history': {
        mtimeMs: 1000,
        lines: ['bash-command'],
      },
    })
    const observer = createTerminalHistoryObserver(
      makeOptions({
        fileReader: reader,
        historyPaths: ['/home/user/.bash_history'],
      }),
    )

    const observations = await observer.poll()
    expect(observations[0]!.tags).toEqual(expect.arrayContaining([expect.stringContaining('bash')]))
  })

  it('first poll reads last N lines (not entire history)', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `cmd-${i}`)
    const reader = createMockFileReader({
      '/home/user/.zsh_history': { mtimeMs: 1000, lines },
    })
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    const observations = await observer.poll()
    // On first poll, should cap at last 50 lines max per batch
    const allContent = observations.map((o) => o.content).join('\n')
    // Should not contain the earliest commands
    expect(allContent).not.toContain('cmd-0')
    // Should contain recent commands
    expect(allContent).toContain('cmd-199')
  })

  it('large history file handled efficiently (incremental read)', async () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `cmd-${i}`)
    const reader = createMockFileReader({
      '/home/user/.zsh_history': { mtimeMs: 1000, lines },
    })
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    // First poll should not process all 10000 lines
    const observations = await observer.poll()
    const totalLines = observations.reduce((sum, o) => sum + o.content.split('\n').length, 0)
    expect(totalLines).toBeLessThanOrEqual(100)
  })

  it('sanitizer removes tokens/passwords from commands', async () => {
    const reader = createMockFileReader({
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: [
          'curl -H "Authorization: Bearer mytoken123456" https://api.example.com',
          'export PASSWORD=supersecret',
        ],
      },
    })
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    const observations = await observer.poll()
    const content = observations[0]!.content
    expect(content).toContain('[REDACTED]')
  })

  it('history file grows between polls → reads only new portion', async () => {
    const files: Record<string, { mtimeMs: number; lines: string[] }> = {
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: ['first', 'second'],
      },
    }
    const reader = createMockFileReader(files)
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    await observer.poll()

    files['/home/user/.zsh_history'] = {
      mtimeMs: 2000,
      lines: ['first', 'second', 'third', 'fourth'],
    }

    const observations = await observer.poll()
    expect(observations).toHaveLength(1)
    expect(observations[0]!.content).toContain('third')
    expect(observations[0]!.content).toContain('fourth')
    expect(observations[0]!.content).not.toContain('first')
  })

  it('empty history file → no observations', async () => {
    const reader = createMockFileReader({
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: [],
      },
    })
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    const observations = await observer.poll()
    expect(observations).toHaveLength(0)
  })

  it('writes observations to daily log', async () => {
    const appendDailyLog = vi.fn()
    const logWriter = createDailyLogWriter({ appendDailyLog })
    const reader = createMockFileReader({
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: ['git push'],
      },
    })
    const observer = createTerminalHistoryObserver(
      makeOptions({
        fileReader: reader,
        logWriter,
      }),
    )

    await observer.poll()
    expect(appendDailyLog).toHaveBeenCalled()
  })

  it('skips exact harmless commands but keeps them with arguments', async () => {
    const reader = createMockFileReader({
      '/home/user/.zsh_history': {
        mtimeMs: 1000,
        lines: ['ls', 'ls -la', 'cd', 'cd /home/user/projects'],
      },
    })
    const observer = createTerminalHistoryObserver(makeOptions({ fileReader: reader }))

    const observations = await observer.poll()
    const content = observations[0]!.content
    expect(content).toContain('ls -la')
    expect(content).toContain('cd /home/user/projects')
  })

  it('watches explicitly configured history paths as-is, even off-Unix', async () => {
    // The platform filter applies only to the DEFAULT path set. Explicitly
    // injected paths are deliberate operator/test intent and are watched
    // unchanged — the old behavior silently dropped zsh/bash-named fixture
    // paths on win32 hosts, which made every injected-path test inert there.
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    try {
      const reader = createMockFileReader({
        '/home/user/.zsh_history': { mtimeMs: 1000, lines: ['zsh-cmd'] },
        '/home/user/.bash_history': { mtimeMs: 1000, lines: ['bash-cmd'] },
        'C:/PSReadLine/ConsoleHost_history.txt': { mtimeMs: 1000, lines: ['ps-cmd'] },
      })
      const observer = createTerminalHistoryObserver(
        makeOptions({
          fileReader: reader,
          historyPaths: [
            '/home/user/.zsh_history',
            '/home/user/.bash_history',
            'C:/PSReadLine/ConsoleHost_history.txt',
          ],
        }),
      )

      const observations = await observer.poll()
      expect(observations).toHaveLength(3)
      const all = observations.map((o) => o.content).join('\n')
      expect(all).toContain('ps-cmd')
      expect(all).toContain('zsh-cmd')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('keeps all history paths on Unix platforms', async () => {
    // Simulate linux platform (or darwin — both should keep all)
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    try {
      const reader = createMockFileReader({
        '/home/user/.zsh_history': { mtimeMs: 1000, lines: ['zsh-cmd'] },
        '/home/user/.bash_history': { mtimeMs: 1000, lines: ['bash-cmd'] },
      })
      const observer = createTerminalHistoryObserver(
        makeOptions({
          fileReader: reader,
          historyPaths: ['/home/user/.zsh_history', '/home/user/.bash_history'],
        }),
      )

      const observations = await observer.poll()
      expect(observations).toHaveLength(2)
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })
})

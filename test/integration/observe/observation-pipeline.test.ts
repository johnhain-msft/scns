/**
 * Integration tests for the observation pipeline.
 *
 * Exercises multiple observation-layer modules working together:
 * observers → privacy filter → secret sanitizer → daily log writer.
 * All system calls are mocked — no real osascript, fs.watch, or git.
 */

import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'

import { ObservationType, type Observation } from '../../../src/observe/types.js'
import { createPrivacyFilter } from '../../../src/observe/privacy-filter.js'
import { createSecretSanitizer } from '../../../src/observe/secret-sanitizer.js'
import { createSanitizePipeline } from '../../../src/observe/sanitize-pipeline.js'
import {
  createDailyLogWriter,
  formatObservation,
  type LogWriter,
} from '../../../src/observe/daily-log-writer.js'
import type { CommandExecutor, CommandResult } from '../../../src/observe/command-executor.js'
import { createActiveAppObserver } from '../../../src/observe/observers/active-app.js'
import { createBrowserTabObserver } from '../../../src/observe/observers/browser-tabs.js'
import {
  createFileChangeObserver,
  type FileWatcher,
} from '../../../src/observe/observers/file-changes.js'
import {
  createGitActivityObserver,
  type GitClient,
} from '../../../src/observe/observers/git-activity.js'
import {
  createTerminalHistoryObserver,
  type FileStatReader,
} from '../../../src/observe/observers/terminal-history.js'
import {
  createSessionHookHandler,
  type SessionEventData,
} from '../../../src/observe/observers/session-hooks.js'
import { createPatternDetector } from '../../../src/observe/pattern-detector.js'
import {
  createObservationManager,
  type ObserverFactory,
} from '../../../src/observe/observation-manager.js'
import type { ObservationConfig } from '../../../src/observe/config.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeObservation(overrides?: Partial<Observation>): Observation {
  return {
    id: randomUUID(),
    type: ObservationType.ActiveApp,
    timestamp: new Date().toISOString(),
    source: 'TestApp',
    content: 'Test window',
    tags: ['type:active-app', 'source:testapp'],
    ...overrides,
  }
}

function makeMockExecutor(responses: Record<string, CommandResult>): CommandExecutor {
  return {
    async execute(command: string, args?: readonly string[]) {
      const key = args ? `${command} ${args.join(' ')}` : command
      return responses[key] ?? { stdout: '', stderr: '', exitCode: 1 }
    },
  }
}

function makeMockLogWriter(): LogWriter & { entries: string[] } {
  const entries: string[] = []
  return {
    entries,
    appendDailyLog(entry: string) {
      entries.push(entry)
    },
  }
}

function makeMockGitClient(
  commits: {
    hash: string
    author: string
    date: string
    message: string
    filesChanged: number
  }[],
): GitClient {
  return {
    async log() {
      return commits
    },
    async branches() {
      return ['main']
    },
    async currentBranch() {
      return 'main'
    },
    async isRepo() {
      return true
    },
  }
}

function makeTimestamp(daysAgo: number, hour: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setUTCHours(hour, 0, 0, 0)
  return d.toISOString()
}

// ═════════════════════════════════════════════════════════════════════
// 1. Full Observation Cycle
// ═════════════════════════════════════════════════════════════════════

describe('Full Observation Cycle', () => {
  it('active-app observer → poll → observation written to daily log', async () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const filter = createPrivacyFilter({
      config: {
        excludeApps: [],
        excludePaths: [],
        excludeUrls: [],
        sanitizeSecrets: true,
        terminalHistoryOptIn: false,
        browserTabsOptIn: false,
      },
    })
    const executor = makeMockExecutor({
      'osascript -e tell application "System Events" to get name of first application process whose frontmost is true':
        { stdout: 'VSCode\n', stderr: '', exitCode: 0 },
      'osascript -e tell application "System Events" to get title of front window of first application process whose frontmost is true':
        { stdout: 'index.ts — my-project\n', stderr: '', exitCode: 0 },
    })

    const observer = createActiveAppObserver({
      executor,
      logWriter: dailyLog,
      privacyFilter: filter,
      config: { enabled: true, optIn: false },
    })
    const obs = await observer.poll()

    expect(obs).not.toBeNull()
    expect(obs!.type).toBe(ObservationType.ActiveApp)
    expect(obs!.source).toBe('VSCode')
    expect(obs!.content).toBe('index.ts — my-project')
    expect(logWriter.entries).toHaveLength(1)
    expect(logWriter.entries[0]).toContain('active-app')
    expect(logWriter.entries[0]).toContain('index.ts — my-project')
  })

  it('git observer → poll → commits logged', async () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const filter = createPrivacyFilter({
      config: {
        excludeApps: [],
        excludePaths: [],
        excludeUrls: [],
        sanitizeSecrets: true,
        terminalHistoryOptIn: false,
        browserTabsOptIn: false,
      },
    })
    const gitClient = makeMockGitClient([
      {
        hash: 'abc1234',
        author: 'dev',
        date: new Date().toISOString(),
        message: 'feat: add login',
        filesChanged: 3,
      },
      {
        hash: 'def5678',
        author: 'dev',
        date: new Date().toISOString(),
        message: 'fix: typo in readme',
        filesChanged: 1,
      },
    ])

    const observer = createGitActivityObserver({
      gitClient,
      logWriter: dailyLog,
      privacyFilter: filter,
      config: { enabled: true, optIn: false, repos: ['/fake/repo'] },
    })
    const observations = await observer.poll()

    expect(observations.length).toBeGreaterThanOrEqual(2)
    expect(observations[0]!.type).toBe(ObservationType.GitActivity)
    expect(observations[0]!.content).toBe('feat: add login')
    expect(logWriter.entries.length).toBeGreaterThanOrEqual(2)
  })

  it('terminal observer → poll → secrets stripped before logging', async () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const filter = createPrivacyFilter({
      config: {
        excludeApps: [],
        excludePaths: [],
        excludeUrls: [],
        sanitizeSecrets: true,
        terminalHistoryOptIn: true,
        browserTabsOptIn: false,
      },
    })
    const sanitizer = createSecretSanitizer()

    const historyContent =
      'echo hello\nexport API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234\nnpm install\n'
    const fileReader: FileStatReader = {
      stat() {
        return { mtimeMs: Date.now() }
      },
      readLines(_path: string, fromLine: number) {
        return historyContent.split('\n').slice(fromLine)
      },
      lineCount() {
        return historyContent.split('\n').length
      },
    }

    const observer = createTerminalHistoryObserver({
      fileReader,
      sanitizer,
      logWriter: dailyLog,
      privacyFilter: filter,
      config: { enabled: true, optIn: true },
      historyPaths: ['/fake/.zsh_history'],
    })

    const observations = await observer.poll()
    expect(observations.length).toBeGreaterThanOrEqual(1)

    const allContent = observations.map((o) => o.content).join('\n')
    expect(allContent).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234')
    expect(allContent).toContain('[REDACTED]')
    expect(logWriter.entries.length).toBeGreaterThanOrEqual(1)
  })

  it('session hook handler → handle event → observation written', () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const handler = createSessionHookHandler({
      logWriter: dailyLog,
      config: { enabled: true, optIn: false },
    })

    const event: SessionEventData = {
      event: 'session-start',
      sessionId: 'sess-42',
      timestamp: new Date().toISOString(),
    }

    const obs = handler.handleEvent(event)
    expect(obs.type).toBe(ObservationType.SessionHook)
    expect(obs.content).toContain('sess-42')
    expect(obs.content).toContain('started')
    expect(logWriter.entries).toHaveLength(1)
  })

  it('multiple observer types produce correctly-tagged entries', async () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const filter = createPrivacyFilter({
      config: {
        excludeApps: [],
        excludePaths: [],
        excludeUrls: [],
        sanitizeSecrets: true,
        terminalHistoryOptIn: true,
        browserTabsOptIn: false,
      },
    })
    createSecretSanitizer()

    // Active app
    const appExecutor = makeMockExecutor({
      'osascript -e tell application "System Events" to get name of first application process whose frontmost is true':
        { stdout: 'Safari\n', stderr: '', exitCode: 0 },
      'osascript -e tell application "System Events" to get title of front window of first application process whose frontmost is true':
        { stdout: 'GitHub\n', stderr: '', exitCode: 0 },
    })
    const appObs = createActiveAppObserver({
      executor: appExecutor,
      logWriter: dailyLog,
      privacyFilter: filter,
      config: { enabled: true, optIn: false },
    })
    await appObs.poll()

    // Git
    const gitClient = makeMockGitClient([
      {
        hash: 'aaa1111',
        author: 'dev',
        date: new Date().toISOString(),
        message: 'init commit',
        filesChanged: 1,
      },
    ])
    const gitObs = createGitActivityObserver({
      gitClient,
      logWriter: dailyLog,
      privacyFilter: filter,
      config: { enabled: true, optIn: false, repos: ['/fake/repo'] },
    })
    await gitObs.poll()

    // Session hook
    const hookHandler = createSessionHookHandler({
      logWriter: dailyLog,
      config: { enabled: true, optIn: false },
    })
    hookHandler.handleEvent({
      event: 'tool-use',
      tool: 'read_file',
      timestamp: new Date().toISOString(),
    })

    expect(logWriter.entries.length).toBeGreaterThanOrEqual(3)
    expect(logWriter.entries.some((e) => e.includes('[active-app]'))).toBe(true)
    expect(logWriter.entries.some((e) => e.includes('[git-activity]'))).toBe(true)
    expect(logWriter.entries.some((e) => e.includes('[session-hook]'))).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════
// 2. Privacy Filtering Pipeline
// ═════════════════════════════════════════════════════════════════════

describe('Privacy Filtering Pipeline', () => {
  it('excluded app is NOT logged', async () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const filter = createPrivacyFilter({
      config: {
        excludeApps: ['1Password'],
        excludePaths: [],
        excludeUrls: [],
        sanitizeSecrets: true,
        terminalHistoryOptIn: false,
        browserTabsOptIn: false,
      },
    })
    const executor = makeMockExecutor({
      'osascript -e tell application "System Events" to get name of first application process whose frontmost is true':
        { stdout: '1Password\n', stderr: '', exitCode: 0 },
    })

    const observer = createActiveAppObserver({
      executor,
      logWriter: dailyLog,
      privacyFilter: filter,
      config: { enabled: true, optIn: false },
    })
    const obs = await observer.poll()

    expect(obs).toBeNull()
    expect(logWriter.entries).toHaveLength(0)
  })

  it('excluded path is NOT logged (file change observer)', () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const filter = createPrivacyFilter({
      config: {
        excludeApps: [],
        excludePaths: ['**/secret-dir/**'],
        excludeUrls: [],
        sanitizeSecrets: true,
        terminalHistoryOptIn: false,
        browserTabsOptIn: false,
      },
    })

    let capturedCallback: ((event: string, filename: string | null) => void) | null = null
    const mockWatcher: FileWatcher = {
      watch(_dir, _opts, callback) {
        capturedCallback = callback
        return {
          close() {
            /* noop */
          },
        }
      },
    }

    const observer = createFileChangeObserver({
      watcher: mockWatcher,
      logWriter: dailyLog,
      privacyFilter: filter,
      config: { enabled: true, optIn: false, directories: ['/project'] },
      debounceMs: 0,
    })

    observer.start()
    expect(capturedCallback).not.toBeNull()

    // Trigger event on excluded path
    capturedCallback!('change', 'secret-dir/passwords.txt')

    // Give debounce a moment (0ms debounce, but setTimeout is still async)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(logWriter.entries).toHaveLength(0)
        observer.stop()
        resolve()
      }, 50)
    })
  })

  it('excluded URL is NOT logged (browser tab observer)', async () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const filter = createPrivacyFilter({
      config: {
        excludeApps: [],
        excludePaths: [],
        excludeUrls: ['**banking**'],
        sanitizeSecrets: true,
        terminalHistoryOptIn: false,
        browserTabsOptIn: true,
      },
    })
    const executor = makeMockExecutor({
      'pgrep -x Google Chrome': { stdout: '123\n', stderr: '', exitCode: 0 },
      'osascript -e tell application "Google Chrome" to get {URL, title} of active tab of front window':
        { stdout: 'https://mybanking.com/accounts, My Banking\n', stderr: '', exitCode: 0 },
    })

    const observer = createBrowserTabObserver({
      executor,
      logWriter: dailyLog,
      privacyFilter: filter,
      config: { enabled: true, optIn: true },
    })
    const observations = await observer.poll()

    expect(observations).toHaveLength(0)
    expect(logWriter.entries).toHaveLength(0)
  })

  it('mixed observations — only allowed ones logged', async () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const filter = createPrivacyFilter({
      config: {
        excludeApps: ['1Password'],
        excludePaths: [],
        excludeUrls: [],
        sanitizeSecrets: true,
        terminalHistoryOptIn: false,
        browserTabsOptIn: false,
      },
    })

    // First poll: excluded app
    const executor1 = makeMockExecutor({
      'osascript -e tell application "System Events" to get name of first application process whose frontmost is true':
        { stdout: '1Password\n', stderr: '', exitCode: 0 },
    })
    const obs1 = createActiveAppObserver({
      executor: executor1,
      logWriter: dailyLog,
      privacyFilter: filter,
      config: { enabled: true, optIn: false },
    })
    await obs1.poll()

    // Second observer: allowed app
    const executor2 = makeMockExecutor({
      'osascript -e tell application "System Events" to get name of first application process whose frontmost is true':
        { stdout: 'Cursor\n', stderr: '', exitCode: 0 },
      'osascript -e tell application "System Events" to get title of front window of first application process whose frontmost is true':
        { stdout: 'main.ts\n', stderr: '', exitCode: 0 },
    })
    const obs2 = createActiveAppObserver({
      executor: executor2,
      logWriter: dailyLog,
      privacyFilter: filter,
      config: { enabled: true, optIn: false },
    })
    await obs2.poll()

    expect(logWriter.entries).toHaveLength(1)
    expect(logWriter.entries[0]).toContain('active-app')
  })
})

// ═════════════════════════════════════════════════════════════════════
// 3. Secret Sanitization End-to-End
// ═════════════════════════════════════════════════════════════════════

describe('Secret Sanitization End-to-End', () => {
  it('terminal history with API_KEY assignment → key redacted', async () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const filter = createPrivacyFilter({
      config: {
        excludeApps: [],
        excludePaths: [],
        excludeUrls: [],
        sanitizeSecrets: true,
        terminalHistoryOptIn: true,
        browserTabsOptIn: false,
      },
    })
    const sanitizer = createSecretSanitizer()

    const historyContent = 'export API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234\n'
    const fileReader: FileStatReader = {
      stat() {
        return { mtimeMs: Date.now() }
      },
      readLines(_path: string, fromLine: number) {
        return historyContent.split('\n').slice(fromLine)
      },
      lineCount() {
        return historyContent.split('\n').length
      },
    }

    const observer = createTerminalHistoryObserver({
      fileReader,
      sanitizer,
      logWriter: dailyLog,
      privacyFilter: filter,
      config: { enabled: true, optIn: true },
      historyPaths: ['/fake/.zsh_history'],
    })

    const observations = await observer.poll()
    expect(observations.length).toBeGreaterThanOrEqual(1)

    const content = observations.map((o) => o.content).join('\n')
    expect(content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234')
    expect(content).toContain('[REDACTED]')
  })

  it('git commit message containing a token → token redacted', () => {
    const sanitizer = createSecretSanitizer()
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)

    const obs = makeObservation({
      type: ObservationType.GitActivity,
      content: 'fix: remove token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    })

    const sanitized = sanitizer.sanitize(obs.content)
    expect(sanitized).not.toContain('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789')
    expect(sanitized).toContain('[REDACTED]')

    // Write sanitized observation through the pipeline
    const sanitizedObs: Observation = { ...obs, content: sanitized }
    dailyLog.write(sanitizedObs)
    expect(logWriter.entries).toHaveLength(1)
    expect(logWriter.entries[0]).not.toContain('ghp_')
  })

  it('multiple secrets in one observation → all redacted', () => {
    const sanitizer = createSecretSanitizer()
    const text =
      'export SECRET=sk-longapikey12345678901234 and password: hunter2secret and Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123'

    const sanitized = sanitizer.sanitize(text)
    expect(sanitized).not.toContain('sk-longapikey12345678901234')
    expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    // At least 2 redactions
    const count = (sanitized.match(/\[REDACTED\]/g) ?? []).length
    expect(count).toBeGreaterThanOrEqual(2)
  })

  it('sanitize pipeline: filtered observation returns null, allowed returns sanitized text', () => {
    const filter = createPrivacyFilter({
      config: {
        excludeApps: ['1Password'],
        excludePaths: [],
        excludeUrls: [],
        sanitizeSecrets: true,
        terminalHistoryOptIn: false,
        browserTabsOptIn: false,
      },
    })
    const sanitizer = createSecretSanitizer()
    const pipeline = createSanitizePipeline(filter, sanitizer)

    // Filtered: excluded app
    const result1 = pipeline.process({ type: 'active-app', appName: '1Password' }, 'some content')
    expect(result1).toBeNull()

    // Allowed but has secrets
    const result2 = pipeline.process(
      { type: 'active-app', appName: 'VSCode' },
      'password: supersecret123',
    )
    expect(result2).not.toBeNull()
    expect(result2).toContain('[REDACTED]')
    expect(result2).not.toContain('supersecret123')
  })
})

// ═════════════════════════════════════════════════════════════════════
// 4. Pattern Detection from Observations
// ═════════════════════════════════════════════════════════════════════

describe('Pattern Detection from Observations', () => {
  it('detects work schedule patterns from 50 observations over 3 days', () => {
    const detector = createPatternDetector({ windowHours: 168 * 4, minObservations: 10 })
    const observations: Observation[] = []

    for (let day = 0; day < 3; day++) {
      for (let i = 0; i < 17; i++) {
        const hour = 9 + (i % 8) // hours 9-16
        observations.push(
          makeObservation({
            timestamp: makeTimestamp(day, hour),
            source: 'VSCode',
          }),
        )
      }
    }
    // Should have 51 observations
    expect(observations.length).toBe(51)

    const schedule = detector.detectWorkSchedule(observations)
    expect(schedule).not.toBeNull()
    expect(schedule!.activeHours.length).toBeGreaterThan(0)
    expect(schedule!.peakHour).toBeGreaterThanOrEqual(0)
    expect(schedule!.activeDays.length).toBeGreaterThan(0)
  })

  it('detects tool frequency from active-app observations', () => {
    const detector = createPatternDetector({ windowHours: 168 * 4, minObservations: 5 })
    const observations: Observation[] = []

    const apps = ['VSCode', 'VSCode', 'VSCode', 'Chrome', 'Chrome', 'Slack', 'Terminal', 'Terminal']
    for (const app of apps) {
      observations.push(
        makeObservation({
          type: ObservationType.ActiveApp,
          source: app,
          timestamp: makeTimestamp(0, 10),
        }),
      )
    }

    const freq = detector.detectToolFrequency(observations)
    expect(freq).not.toBeNull()
    expect(freq!.topApps[0]).toBe('VSCode')
    expect(freq!.appCounts.get('VSCode')).toBe(3)
    expect(freq!.categoryBreakdown.get('coding')).toBe(3)
    expect(freq!.categoryBreakdown.get('browsing')).toBe(2)
  })

  it('detects project focus from git + file observations', () => {
    const detector = createPatternDetector({ windowHours: 168 * 4, minObservations: 5 })
    const observations: Observation[] = []

    // Git observations for repos
    for (let i = 0; i < 5; i++) {
      observations.push(
        makeObservation({
          type: ObservationType.GitActivity,
          source: 'my-project',
          content: `commit ${i}`,
          timestamp: makeTimestamp(0, 10 + i),
          tags: ['type:git-activity', 'source:my-project'],
        }),
      )
    }
    for (let i = 0; i < 2; i++) {
      observations.push(
        makeObservation({
          type: ObservationType.GitActivity,
          source: 'side-project',
          content: `commit ${i}`,
          timestamp: makeTimestamp(0, 14 + i),
          tags: ['type:git-activity', 'source:side-project'],
        }),
      )
    }

    // File change observations
    for (let i = 0; i < 3; i++) {
      observations.push(
        makeObservation({
          type: ObservationType.FileChange,
          source: '/project',
          content: `change: file${i}.ts`,
          timestamp: makeTimestamp(0, 10 + i),
          tags: ['type:file-change', 'source:/project', 'ext:ts'],
        }),
      )
    }

    const focus = detector.detectProjectFocus(observations)
    expect(focus).not.toBeNull()
    expect(focus!.topRepos[0]).toBe('my-project')
    expect(focus!.repoCounts.get('my-project')).toBe(5)
    expect(focus!.fileTypeCounts.get('ts')).toBe(3)
  })

  it('insufficient observations → patterns return null', () => {
    const detector = createPatternDetector({ windowHours: 168 * 4, minObservations: 20 })
    const observations = [makeObservation({ timestamp: makeTimestamp(0, 10) })]

    const schedule = detector.detectWorkSchedule(observations)
    expect(schedule).toBeNull()
  })

  it('full detect() returns all three pattern types from mixed observations', () => {
    const detector = createPatternDetector({ windowHours: 168 * 4, minObservations: 5 })
    const observations: Observation[] = []

    // Active-app observations for tool frequency
    for (let i = 0; i < 10; i++) {
      observations.push(
        makeObservation({
          type: ObservationType.ActiveApp,
          source: i < 6 ? 'VSCode' : 'Chrome',
          timestamp: makeTimestamp(0, 9 + i),
        }),
      )
    }

    // Git observations for project focus
    for (let i = 0; i < 5; i++) {
      observations.push(
        makeObservation({
          type: ObservationType.GitActivity,
          source: 'main-repo',
          content: `commit ${i}`,
          timestamp: makeTimestamp(0, 10 + i),
          tags: ['type:git-activity', 'source:main-repo'],
        }),
      )
    }

    const result = detector.detect(observations)
    expect(result.observationCount).toBe(15)
    expect(result.workSchedule).not.toBeNull()
    expect(result.toolFrequency).not.toBeNull()
    expect(result.projectFocus).not.toBeNull()
    expect(result.windowStart).toBeTruthy()
    expect(result.windowEnd).toBeTruthy()
  })
})

// ═════════════════════════════════════════════════════════════════════
// 5. Observation Manager Lifecycle
// ═════════════════════════════════════════════════════════════════════

describe('Observation Manager Lifecycle', () => {
  function makeDefaultConfig(overrides?: Partial<ObservationConfig>): ObservationConfig {
    return {
      privacy: {
        excludeApps: [],
        excludePaths: [],
        excludeUrls: [],
        sanitizeSecrets: true,
        terminalHistoryOptIn: false,
        browserTabsOptIn: false,
      },
      activeApp: { enabled: true, optIn: false },
      fileChanges: { enabled: true, optIn: false, directories: ['/fake'] },
      gitActivity: { enabled: true, optIn: false, repos: ['/fake/repo'] },
      terminalHistory: { enabled: false, optIn: false },
      browserTabs: { enabled: false, optIn: false },
      sessionHooks: { enabled: true, optIn: false },
      configChanges: { enabled: false, optIn: false },
      ...overrides,
    }
  }

  function makeMockObserverFactory(): ObserverFactory & { started: string[]; stopped: string[] } {
    const started: string[] = []
    const stopped: string[] = []

    function mockObserver(type: string, name: string) {
      let running = false
      return {
        type: type as import('../../../src/observe/types.js').ObservationType,
        name,
        start() {
          running = true
          started.push(name)
        },
        stop() {
          running = false
          stopped.push(name)
        },
        isRunning() {
          return running
        },
      }
    }

    return {
      started,
      stopped,
      createActiveApp: () => mockObserver('active-app', 'active-app'),
      createBrowserTabs: () => mockObserver('browser-tab', 'browser-tab'),
      createFileChanges: () => mockObserver('file-change', 'file-change'),
      createGitActivity: () => mockObserver('git-activity', 'git-activity'),
      createTerminalHistory: () => mockObserver('terminal-history', 'terminal-history'),
      createSessionHooks: () => {
        let running = false
        started.push('session-hook')
        return {
          type: 'session-hook' as import('../../../src/observe/types.js').ObservationType,
          name: 'session-hook',
          start() {
            running = true
          },
          stop() {
            running = false
            stopped.push('session-hook')
          },
          isRunning() {
            return running
          },
          handleEvent(event: SessionEventData): Observation {
            return makeObservation({
              type: ObservationType.SessionHook,
              source: event.event,
              content: `Session ${event.sessionId ?? 'unknown'}`,
              timestamp: event.timestamp,
            })
          },
        }
      },
      createConfigChanges: () => mockObserver('config-change', 'config-change'),
    }
  }

  it('start → all enabled observers running → stop → all stopped', () => {
    const factory = makeMockObserverFactory()
    const manager = createObservationManager({
      config: makeDefaultConfig(),
      vaultRootDir: '/fake/vault',
      observerFactory: factory,
    })

    manager.start()
    expect(manager.isRunning()).toBe(true)
    const status = manager.getStatus()
    expect(status.state).toBe('running')
    expect(status.observers.length).toBeGreaterThanOrEqual(3)
    expect(status.observers.every((o) => o.running)).toBe(true)

    manager.stop()
    expect(manager.isRunning()).toBe(false)
    expect(manager.getStatus().state).toBe('idle')
    expect(factory.stopped.length).toBeGreaterThanOrEqual(3)
  })

  it('status reflects observer states correctly', () => {
    const factory = makeMockObserverFactory()
    const manager = createObservationManager({
      config: makeDefaultConfig(),
      vaultRootDir: '/fake/vault',
      observerFactory: factory,
    })

    // Before start
    const statusBefore = manager.getStatus()
    expect(statusBefore.state).toBe('idle')
    expect(statusBefore.observers).toHaveLength(0)
    expect(statusBefore.startedAt).toBeNull()

    manager.start()
    const statusRunning = manager.getStatus()
    expect(statusRunning.state).toBe('running')
    expect(statusRunning.startedAt).not.toBeNull()
    expect(statusRunning.observers.some((o) => o.type === 'active-app')).toBe(true)
    expect(statusRunning.observers.some((o) => o.type === 'session-hook')).toBe(true)

    manager.stop()
  })

  it('handleSessionEvent → delegates to hook handler → observation produced', () => {
    const factory = makeMockObserverFactory()
    const manager = createObservationManager({
      config: makeDefaultConfig(),
      vaultRootDir: '/fake/vault',
      observerFactory: factory,
    })

    manager.start()

    const event: SessionEventData = {
      event: 'session-start',
      sessionId: 'test-session-123',
      timestamp: new Date().toISOString(),
    }

    const result = manager.handleSessionEvent(event)
    expect(result).not.toBeNull()
    expect(result!.type).toBe(ObservationType.SessionHook)

    manager.stop()
  })

  it('all observers disabled → start is safe, status shows empty', () => {
    const factory = makeMockObserverFactory()
    const manager = createObservationManager({
      config: makeDefaultConfig({
        activeApp: { enabled: false, optIn: false },
        fileChanges: { enabled: false, optIn: false },
        gitActivity: { enabled: false, optIn: false },
        terminalHistory: { enabled: false, optIn: false },
        browserTabs: { enabled: false, optIn: false },
        sessionHooks: { enabled: false, optIn: false },
      }),
      vaultRootDir: '/fake/vault',
      observerFactory: factory,
    })

    manager.start()
    expect(manager.isRunning()).toBe(true)
    expect(manager.getStatus().observers).toHaveLength(0)

    manager.stop()
    expect(manager.isRunning()).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════
// 6. Daily Log Formatting
// ═════════════════════════════════════════════════════════════════════

describe('Daily Log Formatting', () => {
  it('different observation types produce distinctly formatted log entries', () => {
    const types = [
      { type: ObservationType.ActiveApp, content: 'VSCode editing', tags: ['type:active-app'] },
      {
        type: ObservationType.GitActivity,
        content: 'feat: new feature',
        tags: ['type:git-activity'],
      },
      {
        type: ObservationType.SessionHook,
        content: 'Session started',
        tags: ['type:session-hook'],
      },
      { type: ObservationType.FileChange, content: 'change: index.ts', tags: ['type:file-change'] },
    ]

    const formatted = types.map((t) => formatObservation(makeObservation(t)))

    expect(formatted[0]).toContain('[active-app]')
    expect(formatted[1]).toContain('[git-activity]')
    expect(formatted[2]).toContain('[session-hook]')
    expect(formatted[3]).toContain('[file-change]')

    // Each should be unique
    const unique = new Set(formatted)
    expect(unique.size).toBe(4)
  })

  it('batch write of observations maintains chronological order', () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)

    const obs1 = makeObservation({ content: 'first', timestamp: '2024-01-01T10:00:00.000Z' })
    const obs2 = makeObservation({ content: 'second', timestamp: '2024-01-01T11:00:00.000Z' })
    const obs3 = makeObservation({ content: 'third', timestamp: '2024-01-01T12:00:00.000Z' })

    dailyLog.writeBatch([obs1, obs2, obs3])

    expect(logWriter.entries).toHaveLength(3)
    expect(logWriter.entries[0]).toContain('first')
    expect(logWriter.entries[1]).toContain('second')
    expect(logWriter.entries[2]).toContain('third')
  })

  it('formatted entries include tags, source, and content in readable format', () => {
    const obs = makeObservation({
      type: ObservationType.ActiveApp,
      source: 'Cursor',
      content: 'Editing main.ts',
      tags: ['type:active-app', 'source:cursor'],
    })

    const formatted = formatObservation(obs)
    expect(formatted).toContain('[active-app]')
    expect(formatted).toContain('Editing main.ts')
    expect(formatted).toContain('type:active-app')
    expect(formatted).toContain('source:cursor')
  })
})

// ═════════════════════════════════════════════════════════════════════
// 7. Hook Script Generation
// ═════════════════════════════════════════════════════════════════════

describe('Hook Script Generation', () => {
  it('Claude hook script is valid bash with correct broker URL', () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const handler = createSessionHookHandler({
      logWriter: dailyLog,
      config: { enabled: true, optIn: false },
    })

    const script = handler.generateClaudeHookScript('session-start', 'http://localhost:7777')
    expect(script).toMatch(/^#!\/bin\/bash/)
    expect(script).toContain('http://localhost:7777')
    expect(script).toContain('session-start')
    expect(script).toContain('curl')
    expect(script).toContain('CLAUDE_SESSION_ID')
  })

  it('Copilot hook script is valid bash with correct env vars', () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const handler = createSessionHookHandler({
      logWriter: dailyLog,
      config: { enabled: true, optIn: false },
    })

    const script = handler.generateCopilotHookScript('tool-use', 'http://localhost:8888')
    expect(script).toMatch(/^#!\/bin\/bash/)
    expect(script).toContain('http://localhost:8888')
    expect(script).toContain('tool-use')
    expect(script).toContain('COPILOT_SESSION_ID')
  })

  it('both scripts include proper error handling (curl with -s flag)', () => {
    const logWriter = makeMockLogWriter()
    const dailyLog = createDailyLogWriter(logWriter)
    const handler = createSessionHookHandler({
      logWriter: dailyLog,
      config: { enabled: true, optIn: false },
    })

    const claudeScript = handler.generateClaudeHookScript('session-end', 'http://localhost:7777')
    const copilotScript = handler.generateCopilotHookScript('session-end', 'http://localhost:7777')

    // Both use -s (silent) flag for curl so failures don't produce noisy output
    expect(claudeScript).toContain('curl -s')
    expect(copilotScript).toContain('curl -s')

    // Both POST JSON
    expect(claudeScript).toContain('Content-Type: application/json')
    expect(copilotScript).toContain('Content-Type: application/json')
  })
})

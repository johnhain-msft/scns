import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFileChangeObserver } from '../../../../src/observe/observers/file-changes.js'
import type { FileWatcher } from '../../../../src/observe/observers/file-changes.js'
import { ObservationType } from '../../../../src/observe/types.js'
import type { ObserverConfig } from '../../../../src/observe/types.js'
import { createDailyLogWriter } from '../../../../src/observe/daily-log-writer.js'
import { createPrivacyFilter } from '../../../../src/observe/privacy-filter.js'

function createMockWatcher() {
  const callbacks = new Map<string, (event: string, filename: string | null) => void>()
  const closed = new Set<string>()

  const watcher: FileWatcher = {
    watch(dir, _options, callback) {
      callbacks.set(dir, callback)
      return {
        close() {
          closed.add(dir)
        },
      }
    },
  }

  return {
    watcher,
    trigger(dir: string, event: string, filename: string | null) {
      const cb = callbacks.get(dir)
      if (cb) cb(event, filename)
    },
    isClosed(dir: string) {
      return closed.has(dir)
    },
    callbacks,
  }
}

function createMockLogWriter() {
  const entries: string[] = []
  const writer = createDailyLogWriter({
    appendDailyLog(entry: string) {
      entries.push(entry)
    },
  })
  return { writer, entries }
}

function createTestPrivacyFilter(excludePaths: string[] = []) {
  return createPrivacyFilter({
    config: {
      excludeApps: [],
      excludePaths,
      excludeUrls: [],
      sanitizeSecrets: true,
      terminalHistoryOptIn: false,
      browserTabsOptIn: false,
    },
  })
}

function defaultConfig(dirs: string[] = ['/project']): ObserverConfig {
  return { enabled: true, directories: dirs, optIn: false }
}

describe('FileChangeObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() watches configured directories', () => {
    const mock = createMockWatcher()
    const { writer } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(['/project/a', '/project/b']),
    })

    observer.start()

    expect(mock.callbacks.has('/project/a')).toBe(true)
    expect(mock.callbacks.has('/project/b')).toBe(true)
  })

  it('stop() closes all watchers', () => {
    const mock = createMockWatcher()
    const { writer } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(['/project/a', '/project/b']),
    })

    observer.start()
    observer.stop()

    expect(mock.isClosed('/project/a')).toBe(true)
    expect(mock.isClosed('/project/b')).toBe(true)
  })

  it('file create event produces observation', () => {
    const mock = createMockWatcher()
    const { writer, entries } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      debounceMs: 50,
    })

    observer.start()
    mock.trigger('/project', 'rename', 'newfile.ts')
    vi.advanceTimersByTime(100)

    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]).toContain('file-change')
    expect(entries[0]).toContain('newfile.ts')
  })

  it('file modify event produces observation', () => {
    const mock = createMockWatcher()
    const { writer, entries } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      debounceMs: 50,
    })

    observer.start()
    mock.trigger('/project', 'change', 'src/index.ts')
    vi.advanceTimersByTime(100)

    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]).toContain('change')
    expect(entries[0]).toContain('src/index.ts')
  })

  it('file rename event produces observation', () => {
    const mock = createMockWatcher()
    const { writer, entries } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      debounceMs: 50,
    })

    observer.start()
    mock.trigger('/project', 'rename', 'old-name.ts')
    vi.advanceTimersByTime(100)

    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]).toContain('rename')
  })

  it('events are debounced (rapid changes to same file → single observation)', () => {
    const mock = createMockWatcher()
    const { writer, entries } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      debounceMs: 200,
    })

    observer.start()
    mock.trigger('/project', 'change', 'file.ts')
    vi.advanceTimersByTime(50)
    mock.trigger('/project', 'change', 'file.ts')
    vi.advanceTimersByTime(50)
    mock.trigger('/project', 'change', 'file.ts')
    vi.advanceTimersByTime(300)

    expect(entries.length).toBe(1)
  })

  it('excluded paths are filtered out', () => {
    const mock = createMockWatcher()
    const { writer, entries } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(['/project/secret/**']),
      config: defaultConfig(),
      debounceMs: 50,
    })

    observer.start()
    mock.trigger('/project', 'change', 'secret/keys.env')
    vi.advanceTimersByTime(100)

    expect(entries.length).toBe(0)
  })

  it('node_modules changes are ignored', () => {
    const mock = createMockWatcher()
    const { writer, entries } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      debounceMs: 50,
    })

    observer.start()
    mock.trigger('/project', 'change', 'node_modules/lodash/index.js')
    vi.advanceTimersByTime(100)

    expect(entries.length).toBe(0)
  })

  it('.venv / site-packages changes are ignored', () => {
    const mock = createMockWatcher()
    const { writer, entries } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      debounceMs: 50,
    })

    observer.start()
    mock.trigger('/project', 'rename', '.venv/lib/python3.11/site-packages/scipy/signal/spline.py')
    mock.trigger('/project', 'change', 'venv/bin/activate')
    vi.advanceTimersByTime(100)

    expect(entries.length).toBe(0)
  })

  it('.git directory changes are ignored', () => {
    const mock = createMockWatcher()
    const { writer, entries } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      debounceMs: 50,
    })

    observer.start()
    mock.trigger('/project', 'change', '.git/objects/abc123')
    vi.advanceTimersByTime(100)

    expect(entries.length).toBe(0)
  })

  it('.ssh directory changes are ignored', () => {
    const mock = createMockWatcher()
    const { writer, entries } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      debounceMs: 50,
    })

    observer.start()
    mock.trigger('/project', 'change', '.ssh/id_rsa')
    vi.advanceTimersByTime(100)

    expect(entries.length).toBe(0)
  })

  it('no directories configured → no-op start', () => {
    const mock = createMockWatcher()
    const { writer } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig([]),
    })

    observer.start()

    expect(mock.callbacks.size).toBe(0)
    expect(observer.isRunning()).toBe(false)
  })

  it('watcher error handled gracefully (does not crash)', () => {
    const errorWatcher: FileWatcher = {
      watch(_dir, _options, _callback) {
        throw new Error('Permission denied')
      },
    }
    const { writer } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: errorWatcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    expect(() => observer.start()).not.toThrow()
  })

  it('isRunning() reflects state', () => {
    const mock = createMockWatcher()
    const { writer } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    expect(observer.isRunning()).toBe(false)
    observer.start()
    expect(observer.isRunning()).toBe(true)
    observer.stop()
    expect(observer.isRunning()).toBe(false)
  })

  it('multiple directories watched simultaneously', () => {
    const mock = createMockWatcher()
    const { writer, entries } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(['/a', '/b', '/c']),
      debounceMs: 50,
    })

    observer.start()
    mock.trigger('/a', 'change', 'file1.ts')
    mock.trigger('/b', 'change', 'file2.ts')
    mock.trigger('/c', 'change', 'file3.ts')
    vi.advanceTimersByTime(100)

    expect(entries.length).toBe(3)
  })

  it('getWatchedDirs() returns configured dirs', () => {
    const mock = createMockWatcher()
    const { writer } = createMockLogWriter()
    const dirs = ['/project/src', '/project/test']
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(dirs),
    })

    observer.start()
    expect(observer.getWatchedDirs()).toEqual(dirs)
  })

  it('file extension included in tags', () => {
    const mock = createMockWatcher()
    const observations: Array<{ tags: string[] }> = []
    const mockLogWriter = {
      write(obs: { tags: string[] }) {
        observations.push(obs)
      },
      writeBatch() {},
    }
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: mockLogWriter as ReturnType<typeof createDailyLogWriter>,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      debounceMs: 50,
    })

    observer.start()
    mock.trigger('/project', 'change', 'src/app.tsx')
    vi.advanceTimersByTime(100)

    expect(observations.length).toBe(1)
    const tags = observations[0]!.tags
    expect(tags.some((t: string) => t.includes('ext:') && t.includes('tsx'))).toBe(true)
  })

  it('directory name included in observation source', () => {
    const mock = createMockWatcher()
    const observations: Array<{ source: string }> = []
    const mockLogWriter = {
      write(obs: { source: string }) {
        observations.push(obs)
      },
      writeBatch() {},
    }
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: mockLogWriter as ReturnType<typeof createDailyLogWriter>,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(['/my/project']),
      debounceMs: 50,
    })

    observer.start()
    mock.trigger('/my/project', 'change', 'file.ts')
    vi.advanceTimersByTime(100)

    expect(observations.length).toBe(1)
    expect(observations[0]!.source).toBe('/my/project')
  })

  it('empty filename from watcher handled', () => {
    const mock = createMockWatcher()
    const { writer } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      debounceMs: 50,
    })

    observer.start()
    expect(() => {
      mock.trigger('/project', 'change', null)
      vi.advanceTimersByTime(100)
    }).not.toThrow()
  })

  it('type is file-change', () => {
    const mock = createMockWatcher()
    const { writer } = createMockLogWriter()
    const observer = createFileChangeObserver({
      watcher: mock.watcher,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    expect(observer.type).toBe(ObservationType.FileChange)
  })
})

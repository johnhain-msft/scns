/**
 * Stress: Observation burst — debouncing, concurrent log writes, git polling.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createVault } from '../../src/memory/vault.js'
import { createDailyLogWriter, formatObservation } from '../../src/observe/daily-log-writer.js'
import {
  createFileChangeObserver,
  type FileWatcher,
} from '../../src/observe/observers/file-changes.js'
import {
  createGitActivityObserver,
  type GitClient,
  type GitCommit,
} from '../../src/observe/observers/git-activity.js'
import { createPrivacyFilter } from '../../src/observe/privacy-filter.js'
import type { Observation } from '../../src/observe/types.js'

const EVENT_COUNT = 150
const CONCURRENT_WRITERS = 10

function createTestPrivacyFilter() {
  return createPrivacyFilter({
    config: {
      excludeApps: [],
      excludePaths: [],
      excludeUrls: [],
      sanitizeSecrets: false,
      terminalHistoryOptIn: false,
      browserTabsOptIn: false,
    },
  })
}

describe('Observation Burst Stress Test', { timeout: 60_000 }, () => {
  let vaultDir: string

  beforeAll(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'scns-stress-observe-'))
  })

  afterAll(() => {
    rmSync(vaultDir, { recursive: true, force: true })
  })

  it('debouncing batches rapid file events', async () => {
    const observations: Observation[] = []
    const vault = createVault({ rootDir: join(vaultDir, 'debounce-test') })
    vault.ensureDirs()

    const logWriter = createDailyLogWriter({
      appendDailyLog(entry: string) {
        // Count observations that get through debouncing
        observations.push({
          id: randomUUID(),
          type: 'file-change',
          timestamp: new Date().toISOString(),
          source: 'test',
          content: entry,
          tags: [],
        })
      },
    })

    // Create a mock file watcher that stores callbacks
    const callbacks: Array<(event: string, filename: string | null) => void> = []
    const mockWatcher: FileWatcher = {
      watch(_dir, _options, callback) {
        callbacks.push(callback)
        return { close: () => {} }
      },
    }

    const watchDir = join(vaultDir, 'debounce-test')
    const observer = createFileChangeObserver({
      watcher: mockWatcher,
      logWriter,
      privacyFilter: createTestPrivacyFilter(),
      config: { enabled: true, directories: [watchDir], optIn: false },
      debounceMs: 50, // Short debounce for testing
    })

    observer.start()
    expect(observer.isRunning()).toBe(true)

    // Fire rapid events for the same files — many should be debounced away
    const uniqueFiles = 10
    for (let i = 0; i < EVENT_COUNT; i++) {
      const filename = `file-${i % uniqueFiles}.ts`
      for (const cb of callbacks) {
        cb('change', filename)
      }
    }

    // Wait for debounce period + buffer
    await new Promise<void>((resolve) => setTimeout(resolve, 200))

    observer.stop()

    console.log(
      `Fired ${EVENT_COUNT} events for ${uniqueFiles} unique files → ${observations.length} observations (${((1 - observations.length / EVENT_COUNT) * 100).toFixed(0)}% debounced)`,
    )

    // Should have significantly fewer observations than events
    expect(observations.length).toBeLessThan(EVENT_COUNT)
    // But should have at least one per unique file
    expect(observations.length).toBeGreaterThanOrEqual(uniqueFiles)
    // Should not exceed unique file count much (debounce collapses same-file events)
    expect(observations.length).toBeLessThanOrEqual(uniqueFiles * 2)
  })

  it('ignored paths are filtered (node_modules, .git)', async () => {
    const observations: string[] = []
    const logWriter = createDailyLogWriter({
      appendDailyLog(entry: string) {
        observations.push(entry)
      },
    })

    const callbacks: Array<(event: string, filename: string | null) => void> = []
    const mockWatcher: FileWatcher = {
      watch(_dir, _options, callback) {
        callbacks.push(callback)
        return { close: () => {} }
      },
    }

    const observer = createFileChangeObserver({
      watcher: mockWatcher,
      logWriter,
      privacyFilter: createTestPrivacyFilter(),
      config: { enabled: true, directories: [vaultDir], optIn: false },
      debounceMs: 20,
    })

    observer.start()

    // Fire events for ignored paths
    for (const cb of callbacks) {
      cb('change', 'node_modules/foo/bar.js')
      cb('change', '.git/objects/abc123')
      cb('change', '__pycache__/module.pyc')
      cb('change', 'src/valid.ts') // Only this should pass
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    observer.stop()

    // Only the non-ignored file should generate an observation
    expect(observations.length).toBe(1)
    expect(observations[0]).toContain('valid.ts')
  })

  it('git observer handles rapid polling with mock git client', async () => {
    const observations: Observation[] = []
    const vault = createVault({ rootDir: join(vaultDir, 'git-test') })
    vault.ensureDirs()

    const logWriter = createDailyLogWriter({
      appendDailyLog(entry: string) {
        observations.push({
          id: randomUUID(),
          type: 'git-activity',
          timestamp: new Date().toISOString(),
          source: 'test',
          content: entry,
          tags: [],
        })
      },
    })

    // Mock git client with synthetic commit history
    let pollCount = 0
    const mockGitClient: GitClient = {
      async log(_repoPath, _since, _maxCount): Promise<GitCommit[]> {
        pollCount++
        // Each poll returns a few new commits
        return Array.from({ length: 3 }, (_, i) => ({
          hash: randomUUID().replace(/-/g, ''),
          author: 'Test Author',
          date: new Date().toISOString(),
          message: `Commit ${pollCount}-${i}: Fix bug #${Math.floor(Math.random() * 100)}`,
          filesChanged: Math.floor(Math.random() * 5) + 1,
        }))
      },
      async branches(_repoPath): Promise<string[]> {
        return ['main', 'develop', `feature-${pollCount}`]
      },
      async currentBranch(_repoPath): Promise<string> {
        return 'main'
      },
      async isRepo(_path): Promise<boolean> {
        return true
      },
    }

    const observer = createGitActivityObserver({
      gitClient: mockGitClient,
      logWriter,
      privacyFilter: createTestPrivacyFilter(),
      config: {
        enabled: true,
        repos: ['/fake/repo1', '/fake/repo2'],
        optIn: false,
      },
      intervalMs: 50, // Very short interval for stress testing
    })

    observer.start()
    expect(observer.isRunning()).toBe(true)

    // Let it poll several times
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    observer.stop()

    console.log(
      `Git observer polled ${pollCount} times, generated ${observations.length} observations`,
    )

    expect(pollCount).toBeGreaterThan(2)
    expect(observations.length).toBeGreaterThan(0)
  })

  it('daily log writer handles concurrent writes without corruption', async () => {
    const logDir = join(vaultDir, 'concurrent-logs')
    const vault = createVault({ rootDir: logDir })
    vault.ensureDirs()

    const totalEntries = CONCURRENT_WRITERS * 20
    const date = new Date('2025-06-15T12:00:00Z')

    // Simulate concurrent observers writing to the daily log
    const writePromises: Promise<void>[] = []
    for (let w = 0; w < CONCURRENT_WRITERS; w++) {
      writePromises.push(
        (async () => {
          for (let i = 0; i < 20; i++) {
            // Small random delay to increase interleaving
            if (i % 5 === 0) {
              await new Promise<void>((r) => setTimeout(r, Math.random() * 5))
            }
            vault.appendDailyLog(`Writer-${w} Entry-${i}: observation data here`, date)
          }
        })(),
      )
    }

    const start = performance.now()
    await Promise.all(writePromises)
    const elapsed = performance.now() - start

    console.log(
      `${CONCURRENT_WRITERS} concurrent writers × 20 entries = ${totalEntries} writes in ${elapsed.toFixed(1)}ms`,
    )

    // Verify the log file exists and has all entries
    const logPath = join(logDir, 'daily', '2025-06-15.md')
    expect(existsSync(logPath)).toBe(true)

    const content = readFileSync(logPath, 'utf-8')

    // Count how many entries made it in — all should be present
    let entryCount = 0
    for (let w = 0; w < CONCURRENT_WRITERS; w++) {
      for (let i = 0; i < 20; i++) {
        if (content.includes(`Writer-${w} Entry-${i}`)) {
          entryCount++
        }
      }
    }

    console.log(`Found ${entryCount}/${totalEntries} entries in log file`)
    expect(entryCount).toBe(totalEntries)

    // Verify no interleaved/corrupted lines — each "## HH:MM:SS" header
    // should be followed by content, not another header
    const headers = content.match(/^## \d{2}:\d{2}:\d{2}$/gm) ?? []
    // Should have exactly totalEntries headers (one per appendDailyLog call)
    expect(headers.length).toBe(totalEntries)
  })

  it('formatObservation produces well-formed entries for all types', () => {
    const types = [
      'file-change',
      'git-activity',
      'active-app',
      'terminal-history',
      'browser-tab',
      'session-hook',
    ] as const

    for (const type of types) {
      const observation: Observation = {
        id: randomUUID(),
        type,
        timestamp: new Date().toISOString(),
        source: 'stress-test',
        content: `Test content for ${type}`,
        tags: ['tag1', 'tag2'],
      }

      const formatted = formatObservation(observation)
      expect(formatted).toContain(`[${type}]`)
      expect(formatted).toContain(`Test content for ${type}`)
      expect(formatted).toContain('tag1')
      expect(formatted).toContain('tag2')
    }
  })

  it('file observer handles null filenames gracefully', async () => {
    const observations: string[] = []
    const logWriter = createDailyLogWriter({
      appendDailyLog(entry: string) {
        observations.push(entry)
      },
    })

    const callbacks: Array<(event: string, filename: string | null) => void> = []
    const mockWatcher: FileWatcher = {
      watch(_dir, _options, callback) {
        callbacks.push(callback)
        return { close: () => {} }
      },
    }

    const observer = createFileChangeObserver({
      watcher: mockWatcher,
      logWriter,
      privacyFilter: createTestPrivacyFilter(),
      config: { enabled: true, directories: [vaultDir], optIn: false },
      debounceMs: 20,
    })

    observer.start()

    // Fire events with null filenames (can happen on some platforms)
    for (const cb of callbacks) {
      cb('change', null)
      cb('rename', null)
      cb('change', 'real-file.ts')
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    observer.stop()

    // Only the non-null filename should generate an observation
    expect(observations.length).toBe(1)
  })
})

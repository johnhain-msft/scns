import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogRotator } from '../../../src/shared/log-rotation.js'

let TEST_LOG_DIR: string

function createTestFile(name: string, content = 'test log content', ageDays = 0): void {
  const path = join(TEST_LOG_DIR, name)
  writeFileSync(path, content)
  if (ageDays > 0) {
    const oldDate = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
    utimesSync(path, oldDate, oldDate)
  }
}

describe('log-rotation', () => {
  beforeEach(() => {
    TEST_LOG_DIR = mkdtempSync(join(tmpdir(), 'scns-log-rotation-'))
  })

  afterEach(() => {
    rmSync(TEST_LOG_DIR, { recursive: true, force: true })
  })

  describe('rotate', () => {
    it('rotates .log files with date suffix', () => {
      createTestFile('app.log', 'some logs', 1)
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR })
      const result = rotator.rotate()
      expect(result.rotated).toContain('app.log')
      expect(result.errors).toHaveLength(0)
    })

    it('rotates .json log files', () => {
      createTestFile('events.json', '{"event":"test"}', 1)
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR })
      const result = rotator.rotate()
      expect(result.rotated).toContain('events.json')
    })

    it('skips non-log files', () => {
      createTestFile('readme.txt', 'not a log', 1)
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR })
      const result = rotator.rotate()
      expect(result.rotated).toHaveLength(0)
    })

    it('skips already-rotated files', () => {
      createTestFile('app.log.2024-01-15', 'old rotated log', 2)
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR })
      const result = rotator.rotate()
      expect(result.rotated).toHaveLength(0)
      expect(result.skipped).toContain('app.log.2024-01-15')
    })

    it('skips empty log files', () => {
      createTestFile('empty.log', '', 1)
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR })
      const result = rotator.rotate()
      expect(result.rotated).toHaveLength(0)
      expect(result.skipped).toContain('empty.log')
    })

    it('handles empty log directory', () => {
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR })
      const result = rotator.rotate()
      expect(result.rotated).toHaveLength(0)
      expect(result.skipped).toHaveLength(0)
      expect(result.errors).toHaveLength(0)
    })

    it('handles non-existent log directory', () => {
      const rotator = createLogRotator({ logDir: join(TEST_LOG_DIR, 'nonexistent') })
      const result = rotator.rotate()
      expect(result.rotated).toHaveLength(0)
    })

    it('rotates files exceeding maxFileSizeMB regardless of date', () => {
      // Create a file that's "today" but exceeds max size (set max to very small)
      createTestFile('big.log', 'x'.repeat(1024))
      const rotator = createLogRotator({
        logDir: TEST_LOG_DIR,
        maxFileSizeMB: 0.0001, // extremely small threshold
      })
      const result = rotator.rotate()
      expect(result.rotated).toContain('big.log')
    })

    it('rotates multiple files at once', () => {
      createTestFile('a.log', 'aaa', 2)
      createTestFile('b.log', 'bbb', 2)
      createTestFile('c.json', '{}', 2)
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR })
      const result = rotator.rotate()
      expect(result.rotated.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('cleanup', () => {
    it('deletes files older than retentionDays', () => {
      createTestFile('old.log.2023-01-01', 'old data', 60)
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR, retentionDays: 30 })
      const result = rotator.cleanup()
      expect(result.deleted).toContain('old.log.2023-01-01')
      expect(result.freedBytes).toBeGreaterThan(0)
    })

    it('keeps files newer than retentionDays', () => {
      createTestFile('recent.log.2024-01-01', 'recent data', 1)
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR, retentionDays: 30 })
      const result = rotator.cleanup()
      expect(result.deleted).toHaveLength(0)
    })

    it('does not delete non-log files even if old', () => {
      createTestFile('important.txt', 'keep me', 60)
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR, retentionDays: 30 })
      const result = rotator.cleanup()
      expect(result.deleted).toHaveLength(0)
      expect(existsSync(join(TEST_LOG_DIR, 'important.txt'))).toBe(true)
    })

    it('handles empty directory', () => {
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR, retentionDays: 30 })
      const result = rotator.cleanup()
      expect(result.deleted).toHaveLength(0)
      expect(result.freedBytes).toBe(0)
    })
  })

  describe('getStats', () => {
    it('returns zeros for empty directory', () => {
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR })
      const stats = rotator.getStats()
      expect(stats.totalFiles).toBe(0)
      expect(stats.totalSizeBytes).toBe(0)
      expect(stats.oldestFile).toBeNull()
      expect(stats.newestFile).toBeNull()
    })

    it('reports correct file count and sizes', () => {
      createTestFile('a.log', 'hello', 2)
      createTestFile('b.log', 'world!', 1)
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR })
      const stats = rotator.getStats()
      expect(stats.totalFiles).toBe(2)
      expect(stats.totalSizeBytes).toBe(5 + 6)
    })

    it('identifies oldest and newest files', () => {
      createTestFile('old.log', 'old', 10)
      createTestFile('new.log', 'new', 1)
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR })
      const stats = rotator.getStats()
      expect(stats.oldestFile).toBe('old.log')
      expect(stats.newestFile).toBe('new.log')
    })

    it('ignores non-log files in stats', () => {
      createTestFile('readme.md', 'not counted')
      createTestFile('app.log', 'counted', 1)
      const rotator = createLogRotator({ logDir: TEST_LOG_DIR })
      const stats = rotator.getStats()
      expect(stats.totalFiles).toBe(1)
    })
  })
})

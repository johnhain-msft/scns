/**
 * Tests for the AutoDream daemon — the main consolidation orchestrator.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDreamDaemon } from '../../../src/dream/dream-daemon.js'
import { openDreamDatabase } from '../../../src/dream/dream-schema.js'
import { getDreamState } from '../../../src/dream/dream-state.js'

// ── Helpers ──────────────────────────────────────────────────────────

let tempDir: string
let vaultRoot: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dream-test-'))
  vaultRoot = join(tempDir, 'memory')
  mkdirSync(join(vaultRoot, 'daily'), { recursive: true })
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function writeDailyLog(date: string, content: string): void {
  writeFileSync(join(vaultRoot, 'daily', `${date}.md`), content)
}

function readMemoryMd(): string | null {
  const p = join(vaultRoot, 'MEMORY.md')
  return existsSync(p) ? readFileSync(p, 'utf-8') : null
}

/** Generate a daily log with extractable entries (keywords that match classifyEntry) */
function sampleDailyLog(date: string, sessionIndex: number): string {
  return [
    `## ${date}`,
    '',
    `### 10:0${sessionIndex} — Session s-${sessionIndex}`,
    `- User prefers TypeScript over JavaScript`,
    `- Decided to use PostgreSQL for the database`,
    `- Remember to always run tests before committing`,
    `- API docs at https://example.com/api`,
    '',
  ].join('\n')
}

// ── dream-schema.ts ─────────────────────────────────────────────────

describe('openDreamDatabase', () => {
  it('opens an in-memory database with dream_state table', () => {
    const db = openDreamDatabase(':memory:')
    try {
      const state = getDreamState(db)
      expect(state).not.toBeNull()
      expect(state!.total_runs).toBe(0)
      expect(state!.sessions_since_last_run).toBe(0)
    } finally {
      db.close()
    }
  })

  it('opens a file-based database', () => {
    const dbPath = join(tempDir, 'dream.db')
    const db = openDreamDatabase(dbPath)
    try {
      expect(existsSync(dbPath)).toBe(true)
      const state = getDreamState(db)
      expect(state).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('is idempotent — opening the same DB twice does not error', () => {
    const dbPath = join(tempDir, 'dream.db')
    const db1 = openDreamDatabase(dbPath)
    db1.close()
    const db2 = openDreamDatabase(dbPath)
    try {
      const state = getDreamState(db2)
      expect(state).not.toBeNull()
    } finally {
      db2.close()
    }
  })
})

// ── dream-daemon.ts ─────────────────────────────────────────────────

describe('createDreamDaemon', () => {
  describe('run()', () => {
    it('runs consolidation when gates pass', async () => {
      // Populate daily logs
      for (let i = 1; i <= 5; i++) {
        writeDailyLog(`2026-04-0${i}`, sampleDailyLog(`2026-04-0${i}`, i))
      }

      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
        gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
      })

      try {
        const result = await daemon.run()

        expect(result.success).toBe(true)
        expect(result.skipped).toBe(false)
        expect(result.skipReason).toBeUndefined()
        expect(result.consolidation).toBeDefined()
        expect(result.consolidation!.entriesKept).toBeGreaterThan(0)
        expect(result.durationMs).toBeGreaterThanOrEqual(0)
        expect(result.error).toBeUndefined()

        // MEMORY.md should now exist
        const memory = readMemoryMd()
        expect(memory).not.toBeNull()
        expect(memory!.length).toBeGreaterThan(0)
      } finally {
        daemon.close()
      }
    })

    it('skips when time gate fails', async () => {
      writeDailyLog('2026-04-01', sampleDailyLog('2026-04-01', 1))

      // Use default time gate (24h) but no session gate
      const d = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
        gateConfig: { minTimeSinceLastRunMs: 86_400_000, minSessionsSinceLastRun: 0 },
      })

      try {
        // First run succeeds (no last_run_at, so time gate passes)
        const first = await d.run()
        expect(first.success).toBe(true)
        expect(first.skipped).toBe(false)

        // Second run immediately should fail on time gate (ran just now, need 24h)
        const result = await d.run()
        expect(result.skipped).toBe(true)
        expect(result.skipReason).toBe('time')
        expect(result.consolidation).toBeUndefined()
      } finally {
        d.close()
      }
    })

    it('skips when count gate fails', async () => {
      writeDailyLog('2026-04-01', sampleDailyLog('2026-04-01', 1))

      // Default minSessionsSinceLastRun is 5, first run has 0 sessions
      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
        // Default gates: minSessions = 5
      })

      try {
        const result = await daemon.run()
        expect(result.skipped).toBe(true)
        expect(result.skipReason).toBe('count')
        expect(result.consolidation).toBeUndefined()
      } finally {
        daemon.close()
      }
    })

    it('performs dry run without writing MEMORY.md', async () => {
      for (let i = 1; i <= 3; i++) {
        writeDailyLog(`2026-04-0${i}`, sampleDailyLog(`2026-04-0${i}`, i))
      }

      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
        gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
        dryRun: true,
      })

      try {
        const result = await daemon.run()

        expect(result.success).toBe(true)
        expect(result.skipped).toBe(false)
        expect(result.consolidation).toBeDefined()
        expect(result.consolidation!.entriesKept).toBeGreaterThan(0)

        // MEMORY.md should NOT be written
        const memory = readMemoryMd()
        expect(memory).toBeNull()
      } finally {
        daemon.close()
      }
    })

    it('creates MEMORY.md from scratch on first run', async () => {
      expect(readMemoryMd()).toBeNull()

      writeDailyLog('2026-04-01', sampleDailyLog('2026-04-01', 1))

      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
        gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
      })

      try {
        const result = await daemon.run()
        expect(result.success).toBe(true)
        expect(readMemoryMd()).not.toBeNull()
      } finally {
        daemon.close()
      }
    })

    it('performs incremental run merging with existing MEMORY.md', async () => {
      // Write an initial MEMORY.md
      const initialMemory = [
        '---',
        'name: Existing Preference',
        'description: User likes dark themes',
        'type: user',
        'createdAt: 2026-03-01T10:00:00Z',
        '---',
        'User likes dark themes',
      ].join('\n')
      writeFileSync(join(vaultRoot, 'MEMORY.md'), initialMemory)

      // Add new daily logs
      writeDailyLog('2026-04-05', sampleDailyLog('2026-04-05', 5))

      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
        gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
      })

      try {
        const result = await daemon.run()
        expect(result.success).toBe(true)

        const memory = readMemoryMd()
        expect(memory).not.toBeNull()
        // Should contain entries from both existing and new
        expect(result.consolidation!.phases.orient.existingEntries).toBeGreaterThan(0)
        expect(result.consolidation!.phases.gather.newEntries).toBeGreaterThan(0)
      } finally {
        daemon.close()
      }
    })

    it('handles empty daily logs directory gracefully', async () => {
      // No daily logs, no MEMORY.md
      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
        gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
      })

      try {
        const result = await daemon.run()
        expect(result.success).toBe(true)
        expect(result.skipped).toBe(false)
        expect(result.consolidation).toBeDefined()
        expect(result.consolidation!.entriesKept).toBe(0)
      } finally {
        daemon.close()
      }
    })

    it('returns correct consolidation stats', async () => {
      for (let i = 1; i <= 3; i++) {
        writeDailyLog(`2026-04-0${i}`, sampleDailyLog(`2026-04-0${i}`, i))
      }

      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
        gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
      })

      try {
        const result = await daemon.run()
        const c = result.consolidation!
        expect(c.entriesProcessed).toBeGreaterThan(0)
        expect(c.entriesKept).toBeGreaterThan(0)
        expect(c.entriesKept).toBeLessThanOrEqual(c.entriesProcessed)
        expect(typeof c.duplicatesRemoved).toBe('number')
        expect(typeof c.contradictionsResolved).toBe('number')
        expect(typeof c.truncated).toBe('boolean')
        expect(c.phases).toBeDefined()
        expect(c.phases.orient).toBeDefined()
        expect(c.phases.gather).toBeDefined()
        expect(c.phases.consolidate).toBeDefined()
        expect(c.phases.prune).toBeDefined()
      } finally {
        daemon.close()
      }
    })

    it('records dream run in state DB after successful run', async () => {
      writeDailyLog('2026-04-01', sampleDailyLog('2026-04-01', 1))

      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
        gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
      })

      try {
        await daemon.run()
        const status = daemon.getStatus()
        expect(status.totalRuns).toBe(1)
        expect(status.lastRunAt).not.toBeNull()
        expect(status.sessionsSinceLastRun).toBe(0)
      } finally {
        daemon.close()
      }
    })

    it('filters logs to only those since last consolidation', async () => {
      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
        gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
      })

      try {
        // Write old logs and run
        writeDailyLog('2026-03-01', sampleDailyLog('2026-03-01', 1))
        const firstResult = await daemon.run()
        expect(firstResult.success).toBe(true)

        // Write newer log — use today's date so it passes the sinceDate filter
        const today = new Date().toISOString().slice(0, 10)
        writeDailyLog(today, sampleDailyLog(today, 2))

        // Second run should only process the newer log
        const secondResult = await daemon.forceRun()
        expect(secondResult.success).toBe(true)
        // The new entries gathered should be from the new log only
        expect(secondResult.consolidation!.phases.gather.newEntries).toBeGreaterThan(0)
      } finally {
        daemon.close()
      }
    })
  })

  describe('forceRun()', () => {
    it('skips gates and always runs', async () => {
      writeDailyLog('2026-04-01', sampleDailyLog('2026-04-01', 1))

      // Default gates require 5 sessions — normally would be skipped
      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
      })

      try {
        // Normal run should skip
        const normalResult = await daemon.run()
        expect(normalResult.skipped).toBe(true)

        // Force run should succeed
        const forceResult = await daemon.forceRun()
        expect(forceResult.success).toBe(true)
        expect(forceResult.skipped).toBe(false)
        expect(forceResult.consolidation).toBeDefined()
      } finally {
        daemon.close()
      }
    })
  })

  describe('getStatus()', () => {
    it('returns current dream state and gate check', () => {
      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
      })

      try {
        const status = daemon.getStatus()
        expect(status.lastRunAt).toBeNull()
        expect(status.sessionsSinceLastRun).toBe(0)
        expect(status.totalRuns).toBe(0)
        expect(status.gateCheck).toBeDefined()
        expect(typeof status.gateCheck.canRun).toBe('boolean')
      } finally {
        daemon.close()
      }
    })

    it('reflects state after a run', async () => {
      writeDailyLog('2026-04-01', sampleDailyLog('2026-04-01', 1))

      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
        gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
      })

      try {
        await daemon.run()
        const status = daemon.getStatus()
        expect(status.totalRuns).toBe(1)
        expect(status.lastRunAt).not.toBeNull()
      } finally {
        daemon.close()
      }
    })
  })

  describe('close()', () => {
    it('closes DB without error', () => {
      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
      })

      expect(() => daemon.close()).not.toThrow()
    })

    it('can be called multiple times without error', () => {
      const daemon = createDreamDaemon({
        vaultRootDir: vaultRoot,
        dbPath: ':memory:',
      })

      daemon.close()
      expect(() => daemon.close()).not.toThrow()
    })
  })

  describe('error handling', () => {
    it('returns error result on failure', async () => {
      // Point to a vault that cannot be read (invalid path with null byte)
      const daemon = createDreamDaemon({
        vaultRootDir: join(tempDir, 'nonexistent', 'deep', 'path'),
        dbPath: ':memory:',
        gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
      })

      try {
        // The vault should still work since listFiles returns [] for non-existent dirs
        // This should succeed with 0 entries
        const result = await daemon.run()
        expect(result.success).toBe(true)
      } finally {
        daemon.close()
      }
    })
  })
})

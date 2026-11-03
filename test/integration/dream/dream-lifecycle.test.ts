/**
 * Dream lifecycle integration tests.
 *
 * Tests the dream daemon's session counting, gate passing,
 * and the notifySessionCompleted callback wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDreamDaemon } from '../../../src/dream/dream-daemon.js'

// ── Helpers ──────────────────────────────────────────────────────────

let tempDir: string
let vaultRoot: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dream-lifecycle-'))
  vaultRoot = join(tempDir, 'memory')
  mkdirSync(join(vaultRoot, 'daily'), { recursive: true })
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function writeDailyLog(date: string, content: string): void {
  writeFileSync(join(vaultRoot, 'daily', `${date}.md`), content)
}

function sampleDailyLog(date: string, idx: number): string {
  return [
    `## ${date}`,
    '',
    `### 10:0${idx} — Session s-${idx}`,
    `- User prefers TypeScript over JavaScript`,
    `- Decided to use PostgreSQL for the database`,
    `- Remember to always run tests before committing`,
    '',
  ].join('\n')
}

// ── notifySessionCompleted ───────────────────────────────────────────

describe('Dream session counting', () => {
  it('notifySessionCompleted increments sessions_since_last_run', () => {
    const dbPath = join(tempDir, 'dream.db')
    const daemon = createDreamDaemon({
      vaultRootDir: vaultRoot,
      dbPath,
    })

    try {
      const before = daemon.getStatus()
      expect(before.sessionsSinceLastRun).toBe(0)

      daemon.notifySessionCompleted()
      const after = daemon.getStatus()
      expect(after.sessionsSinceLastRun).toBe(1)
    } finally {
      daemon.close()
    }
  })

  it('multiple notifications accumulate', () => {
    const dbPath = join(tempDir, 'dream.db')
    const daemon = createDreamDaemon({
      vaultRootDir: vaultRoot,
      dbPath,
    })

    try {
      for (let i = 0; i < 7; i++) {
        daemon.notifySessionCompleted()
      }
      expect(daemon.getStatus().sessionsSinceLastRun).toBe(7)
    } finally {
      daemon.close()
    }
  })

  it('gates pass after 5 session notifications', () => {
    const dbPath = join(tempDir, 'dream.db')
    const daemon = createDreamDaemon({
      vaultRootDir: vaultRoot,
      dbPath,
      // Default gates: minSessionsSinceLastRun: 5, minTimeSinceLastRunMs: 24h
    })

    try {
      // Initially gates fail (count = 0)
      expect(daemon.getStatus().gateCheck.canRun).toBe(false)
      expect(daemon.getStatus().gateCheck.failedGate).toBe('count')

      // Notify 5 sessions
      for (let i = 0; i < 5; i++) {
        daemon.notifySessionCompleted()
      }

      // Now gates should pass (never run before → time gate passes, 5 sessions → count gate passes)
      expect(daemon.getStatus().gateCheck.canRun).toBe(true)
    } finally {
      daemon.close()
    }
  })

  it('session count resets to 0 after successful run', async () => {
    writeDailyLog('2026-04-01', sampleDailyLog('2026-04-01', 1))

    const dbPath = join(tempDir, 'dream.db')
    const daemon = createDreamDaemon({
      vaultRootDir: vaultRoot,
      dbPath,
      gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
    })

    try {
      // Notify 3 sessions
      for (let i = 0; i < 3; i++) {
        daemon.notifySessionCompleted()
      }
      expect(daemon.getStatus().sessionsSinceLastRun).toBe(3)

      // Run dream
      await daemon.run()

      // Count should be reset
      expect(daemon.getStatus().sessionsSinceLastRun).toBe(0)
    } finally {
      daemon.close()
    }
  })

  it('force-run also resets session count', async () => {
    writeDailyLog('2026-04-01', sampleDailyLog('2026-04-01', 1))

    const dbPath = join(tempDir, 'dream.db')
    const daemon = createDreamDaemon({
      vaultRootDir: vaultRoot,
      dbPath,
    })

    try {
      for (let i = 0; i < 3; i++) {
        daemon.notifySessionCompleted()
      }
      expect(daemon.getStatus().sessionsSinceLastRun).toBe(3)

      // Force run bypasses gates
      const result = await daemon.forceRun()
      expect(result.success).toBe(true)
      expect(result.skipped).toBe(false)

      // Count should be reset
      expect(daemon.getStatus().sessionsSinceLastRun).toBe(0)
    } finally {
      daemon.close()
    }
  })
})

// ── Dream end-to-end with session counting ───────────────────────────

describe('Dream gated run with session counting', () => {
  it('normal run succeeds only when both gates pass', async () => {
    writeDailyLog('2026-04-01', sampleDailyLog('2026-04-01', 1))

    const dbPath = join(tempDir, 'dream.db')
    const daemon = createDreamDaemon({
      vaultRootDir: vaultRoot,
      dbPath,
      // Default: need 5 sessions + 24h since last run
    })

    try {
      // No sessions → count gate blocks
      const blocked = await daemon.run()
      expect(blocked.skipped).toBe(true)
      expect(blocked.skipReason).toBe('count')

      // Add 5 sessions, but time gate already passes (never run before)
      for (let i = 0; i < 5; i++) {
        daemon.notifySessionCompleted()
      }

      const success = await daemon.run()
      expect(success.success).toBe(true)
      expect(success.skipped).toBe(false)
      expect(success.consolidation).toBeDefined()

      // MEMORY.md should be written
      const memPath = join(vaultRoot, 'MEMORY.md')
      expect(existsSync(memPath)).toBe(true)
      const content = readFileSync(memPath, 'utf-8')
      expect(content.length).toBeGreaterThan(0)
    } finally {
      daemon.close()
    }
  })

  it('dream DB persists state across daemon instances', async () => {
    writeDailyLog('2026-04-01', sampleDailyLog('2026-04-01', 1))
    const dbPath = join(tempDir, 'dream.db')

    // First daemon: accumulate sessions
    const d1 = createDreamDaemon({ vaultRootDir: vaultRoot, dbPath })
    try {
      for (let i = 0; i < 3; i++) {
        d1.notifySessionCompleted()
      }
      expect(d1.getStatus().sessionsSinceLastRun).toBe(3)
    } finally {
      d1.close()
    }

    // Second daemon: sessions persist from DB
    const d2 = createDreamDaemon({ vaultRootDir: vaultRoot, dbPath })
    try {
      expect(d2.getStatus().sessionsSinceLastRun).toBe(3)

      // Add 2 more → total 5
      d2.notifySessionCompleted()
      d2.notifySessionCompleted()
      expect(d2.getStatus().sessionsSinceLastRun).toBe(5)
      expect(d2.getStatus().gateCheck.canRun).toBe(true)
    } finally {
      d2.close()
    }
  })
})

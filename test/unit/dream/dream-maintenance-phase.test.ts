/**
 * Integration: the dream daemon's gated, reversible memory-maintenance phase
 * (SIBLING milestone). Proves it is inert by default and, when enabled with a
 * memory DB, reversibly archives stale low-value-tier files while keeping files
 * about freshly-retrieved entities.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDreamDaemon } from '../../../src/dream/dream-daemon.js'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { recordEntityAccess } from '../../../src/memory/memory-access.js'
import type Database from 'better-sqlite3'

let tempDir: string
let vaultRoot: string
let memoryDb: Database.Database

const DAY = Math.floor(Date.now() / 86_400_000)

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dream-maint-'))
  vaultRoot = join(tempDir, 'memory')
  mkdirSync(join(vaultRoot, 'daily'), { recursive: true })
  mkdirSync(join(vaultRoot, 'sessions'), { recursive: true })
  // a daily log so the consolidation run proceeds
  writeFileSync(
    join(vaultRoot, 'daily', '2026-04-01.md'),
    '## 2026-04-01\n\n### 10:00 — s\n- Remember to always run tests before committing\n',
  )
  // low-value telemetry: one about a FRESH entity (broker), one about a STALE entity (magma)
  writeFileSync(join(vaultRoot, 'sessions', 'live.md'), 'the broker daemon restarted on port 3456')
  writeFileSync(join(vaultRoot, 'sessions', 'old.md'), 'magma retrieval pipeline telemetry')
  memoryDb = openMemoryDb(':memory:')
  recordEntityAccess(memoryDb, 'broker', DAY) // broker retrieved today → fresh; magma never → stale
})

afterEach(() => {
  closeMemoryDb(memoryDb)
  rmSync(tempDir, { recursive: true, force: true })
})

function archived(rel: string): boolean {
  return existsSync(join(vaultRoot, 'archive', 'decayed', 'sessions', rel))
}
function present(rel: string): boolean {
  return existsSync(join(vaultRoot, 'sessions', rel))
}

describe('dream daemon — memory maintenance phase', () => {
  it('is INERT by default (no memoryMaintenance flag): nothing is archived', async () => {
    const daemon = createDreamDaemon({
      vaultRootDir: vaultRoot,
      dbPath: ':memory:',
      gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
      memoryDb,
    })
    try {
      const r = await daemon.run()
      expect(r.success).toBe(true)
      expect(present('old.md')).toBe(true)
      expect(present('live.md')).toBe(true)
      expect(archived('old.md')).toBe(false)
    } finally {
      daemon.close()
    }
  })

  it('when ENABLED: reversibly archives the stale file, keeps the fresh-entity file', async () => {
    const daemon = createDreamDaemon({
      vaultRootDir: vaultRoot,
      dbPath: ':memory:',
      gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
      memoryDb,
      memoryMaintenance: true,
    })
    try {
      const r = await daemon.run()
      expect(r.success).toBe(true)
      // stale 'magma' telemetry forgotten (moved to archive/, recoverable)
      expect(present('old.md')).toBe(false)
      expect(archived('old.md')).toBe(true)
      // fresh 'broker' telemetry kept ("use it or lose it")
      expect(present('live.md')).toBe(true)
      expect(archived('live.md')).toBe(false)
    } finally {
      daemon.close()
    }
  })

  it('ENABLED + warm-up guard on a COLD signal: archives nothing (cold-start coupling fix)', async () => {
    // Only one access recorded (beforeEach) → signal is cold relative to the guard,
    // so the phase must NOT archive the stale telemetry even though it is enabled.
    const daemon = createDreamDaemon({
      vaultRootDir: vaultRoot,
      dbPath: ':memory:',
      gateConfig: { minTimeSinceLastRunMs: 0, minSessionsSinceLastRun: 0 },
      memoryDb,
      memoryMaintenance: true,
      maintenanceGuard: { minWarmupAccesses: 20, minWarmupEntities: 3 },
    })
    try {
      const r = await daemon.run()
      expect(r.success).toBe(true)
      // cold guard ⇒ nothing forgotten yet (both files still present, nothing archived)
      expect(present('old.md')).toBe(true)
      expect(present('live.md')).toBe(true)
      expect(archived('old.md')).toBe(false)
    } finally {
      daemon.close()
    }
  })
})

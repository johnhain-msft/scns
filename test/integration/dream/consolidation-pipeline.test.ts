/**
 * Integration tests for the AutoDream consolidation pipeline.
 *
 * Exercises the full extraction → consolidation → limits pipeline
 * end-to-end with real filesystem (temp dirs) and real SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

import { extractFromLog, extractFromMultipleLogs } from '../../../src/dream/extraction.js'
import { runConsolidation } from '../../../src/dream/consolidation.js'
import { parseMemoryMd, serializeMemoryMd } from '../../../src/dream/memory-entries.js'
import type { MemoryEntry } from '../../../src/dream/memory-entries.js'
import {
  countLines,
  countBytes,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
} from '../../../src/dream/memory-limits.js'
import {
  initDreamState,
  getDreamState,
  acquireDreamLock,
  releaseDreamLock,
  incrementSessionCount,
  recordDreamRun,
} from '../../../src/dream/dream-state.js'
import { checkDreamGates } from '../../../src/dream/dream-gates.js'

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string
let vaultRoot: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dream-integration-'))
  vaultRoot = join(tempDir, 'memory')
  mkdirSync(join(vaultRoot, 'daily'), { recursive: true })
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

/** Write a daily log file and return its path. */
function writeDailyLog(date: string, content: string): string {
  const path = join(vaultRoot, 'daily', `${date}.md`)
  writeFileSync(path, content, 'utf-8')
  return path
}

/** Read all daily logs from the vault and run extraction on them. */
function extractAllLogs(
  logs: ReadonlyArray<{ date: string; content: string }>,
): ReadonlyArray<MemoryEntry> {
  // Write to disk first (integration-style), then read back and extract
  for (const log of logs) {
    writeDailyLog(log.date, log.content)
  }
  const readBack = logs.map((l) => ({
    content: readFileSync(join(vaultRoot, 'daily', `${l.date}.md`), 'utf-8'),
    date: l.date,
  }))
  return extractFromMultipleLogs(readBack)
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const FIVE_DAY_LOGS = [
  {
    date: '2026-04-01',
    content: `## 2026-04-01\n\n### 10:00 — Session s1\n- User prefers TypeScript over JavaScript\n- Working on SCNS project setup\n`,
  },
  {
    date: '2026-04-02',
    content: `## 2026-04-02\n\n### 09:30 — Session s2\n- Decided to use PostgreSQL for database\n- User likes functional programming patterns\n`,
  },
  {
    date: '2026-04-03',
    content: `## 2026-04-03\n\n### 14:00 — Session s3\n- Configured ESLint with flat config\n- User prefers async/await over callbacks\n- Dashboard at https://grafana.example.com\n`,
  },
  {
    date: '2026-04-04',
    content: `## 2026-04-04\n\n### 11:00 — Session s4\n- User dislikes tabs, prefers 2-space indentation\n- Deployed to Azure App Service\n`,
  },
  {
    date: '2026-04-05',
    content: `## 2026-04-05\n\n### 16:00 — Session s5\n- Remember to always run tests before committing\n- Using Vitest for testing framework\n`,
  },
] as const

// ===========================================================================
// 1. Full consolidation cycle
// ===========================================================================

describe('Full consolidation cycle', () => {
  it('should extract from 5 daily logs, consolidate, and produce valid MEMORY.md', () => {
    const extracted = extractAllLogs(FIVE_DAY_LOGS)
    expect(extracted.length).toBeGreaterThan(0)

    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries: extracted,
      referenceDate: new Date('2026-04-06T00:00:00Z'),
    })

    // Pipeline produced output
    expect(result.memoryMd).toBeTruthy()
    expect(result.entriesKept).toBeGreaterThan(0)

    // Re-parse the output to verify it's valid MEMORY.md
    const reparsed = parseMemoryMd(result.memoryMd)
    expect(reparsed.length).toBe(result.entriesKept)

    // Verify key facts are present in the consolidated output
    const allContent = result.memoryMd.toLowerCase()
    expect(allContent).toContain('typescript')
    expect(allContent).toContain('postgresql')
    expect(allContent).toContain('async/await')
  })

  it('should preserve user preferences as highest priority entries', () => {
    const extracted = extractAllLogs(FIVE_DAY_LOGS)
    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries: extracted,
      referenceDate: new Date('2026-04-06T00:00:00Z'),
    })

    const entries = parseMemoryMd(result.memoryMd)
    const userEntries = entries.filter((e) => e.type === 'user')

    // User preferences should be present (TypeScript, async/await, functional, indentation)
    expect(userEntries.length).toBeGreaterThanOrEqual(2)

    // User entries should be sorted before lower-priority types
    const firstNonUser = entries.findIndex((e) => e.type !== 'user')
    const lastUser = entries.reduce((last, e, i) => (e.type === 'user' ? i : last), -1)
    // All user entries should come before all non-user entries
    if (firstNonUser !== -1 && lastUser !== -1) {
      expect(lastUser).toBeLessThan(firstNonUser)
    }
  })

  it('should include reference entries with URLs', () => {
    const extracted = extractAllLogs(FIVE_DAY_LOGS)
    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries: extracted,
      referenceDate: new Date('2026-04-06T00:00:00Z'),
    })

    const entries = parseMemoryMd(result.memoryMd)
    const referenceEntries = entries.filter((e) => e.type === 'reference')

    expect(referenceEntries.length).toBeGreaterThanOrEqual(1)
    const refContent = referenceEntries.map((e) => e.content).join(' ')
    expect(refContent).toContain('https://grafana.example.com')
  })

  it('should track phase statistics correctly', () => {
    const extracted = extractAllLogs(FIVE_DAY_LOGS)
    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries: extracted,
      referenceDate: new Date('2026-04-06T00:00:00Z'),
    })

    expect(result.phases.orient.existingEntries).toBe(0) // no existing MEMORY.md
    expect(result.phases.gather.newEntries).toBe(extracted.length)
    expect(result.phases.consolidate.merged).toBe(extracted.length)
    expect(result.entriesProcessed).toBe(extracted.length)
    expect(result.entriesKept).toBeLessThanOrEqual(extracted.length)
  })
})

// ===========================================================================
// 2. Contradiction removal
// ===========================================================================

describe('Contradiction removal', () => {
  it('should keep only the latest when same-named entries contradict', () => {
    // Contradiction resolution is name-based: same name → keep later.
    // Construct entries directly with matching names to test the pipeline.
    const oldEntry: MemoryEntry = {
      type: 'user',
      name: 'Indentation Preference',
      description: 'User prefers tabs for indentation',
      content: 'User prefers tabs for indentation',
      source: 'daily-log:2026-04-01',
      createdAt: '2026-04-01T10:00:00Z',
    }
    const newEntry: MemoryEntry = {
      type: 'user',
      name: 'Indentation Preference',
      description: 'User prefers spaces for indentation',
      content: 'User prefers spaces for indentation',
      source: 'daily-log:2026-04-05',
      createdAt: '2026-04-05T16:00:00Z',
    }

    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries: [oldEntry, newEntry],
      referenceDate: new Date('2026-04-06T00:00:00Z'),
    })

    const entries = parseMemoryMd(result.memoryMd)
    const indentMemory = entries.filter((e) => e.content.toLowerCase().includes('indentation'))

    // Should have exactly one entry (the later one with "spaces")
    expect(indentMemory.length).toBe(1)
    expect(indentMemory[0]!.content.toLowerCase()).toContain('spaces')
    expect(indentMemory[0]!.content.toLowerCase()).not.toContain('tabs')
    expect(result.contradictionsResolved).toBeGreaterThanOrEqual(1)
  })

  it('should resolve contradictions from existing MEMORY.md with new entries', () => {
    // Existing MEMORY.md has an old preference
    const existingEntry: MemoryEntry = {
      type: 'user',
      name: 'Editor Preference',
      description: 'User prefers Vim for editing',
      content: 'User prefers Vim for editing',
      source: 'daily-log:2026-04-01',
      createdAt: '2026-04-01T10:00:00Z',
    }
    const existingMemoryMd = serializeMemoryMd([existingEntry])

    // New entry contradicts (same name)
    const newEntry: MemoryEntry = {
      type: 'user',
      name: 'Editor Preference',
      description: 'User prefers VS Code for editing',
      content: 'User prefers VS Code for editing',
      source: 'daily-log:2026-04-05',
      createdAt: '2026-04-05T16:00:00Z',
    }

    const result = runConsolidation({
      currentMemoryMd: existingMemoryMd,
      newEntries: [newEntry],
      referenceDate: new Date('2026-04-06T00:00:00Z'),
    })

    expect(result.contradictionsResolved).toBeGreaterThanOrEqual(1)

    const entries = parseMemoryMd(result.memoryMd)
    const editorEntries = entries.filter((e) => e.name === 'Editor Preference')
    expect(editorEntries.length).toBe(1)
    expect(editorEntries[0]!.content.toLowerCase()).toContain('vs code')
  })

  it('should resolve contradictions produced by extraction when names match', () => {
    // Two logs that produce the same generated entry name via extraction
    // "User prefers Vim" and re-using the exact same phrase updates it
    const logs = [
      {
        date: '2026-04-01',
        content: `## 2026-04-01\n\n### 10:00 — Session s1\n- User prefers dark theme\n`,
      },
      {
        date: '2026-04-05',
        content: `## 2026-04-05\n\n### 16:00 — Session s5\n- User prefers dark theme\n`,
      },
    ]

    const extracted = extractAllLogs(logs)

    // Deduplication in extractFromMultipleLogs keeps the later entry
    // Both produce the same name → deduplicated to one
    const darkEntries = extracted.filter((e) => e.content.toLowerCase().includes('dark theme'))
    expect(darkEntries.length).toBe(1)
    // The surviving entry should be from the later date
    expect(darkEntries[0]!.createdAt).toContain('2026-04-05')
  })
})

// ===========================================================================
// 3. Session extraction quality
// ===========================================================================

describe('Session extraction quality', () => {
  const richLog = [
    `## 2026-04-05`,
    ``,
    `### 09:00 — Session long-session`,
    `- Started refactoring the auth module`,
    `- User prefers JWT over session-based auth`,
    `- Decided to use bcrypt for password hashing`,
    `- Encountered rate limiting on the API`,
    `- User always wants explicit error handling`,
    `- Fixed bug in the token refresh logic`,
    `- User dislikes silent error swallowing`,
    `- Remember to validate all inputs with Zod`,
    `- Documentation at https://docs.example.com/auth`,
    `- Configured Prettier with 2-space indent`,
    `- User prefers named exports over default exports`,
    `- Deployed auth service to staging`,
    `- User likes descriptive variable names`,
    `- Decided to use pnpm over npm`,
    `- Remember to check for null before accessing properties`,
    `- Dashboard at https://monitoring.example.com/auth`,
    `- User dislikes magic numbers in code`,
    `- Using Redis for session caching`,
    `- Architecture follows hexagonal pattern`,
    `- User prefers arrow functions for callbacks`,
    `- Remember to add unit tests for edge cases`,
    `- Docs at https://wiki.example.com/auth-flow`,
    `- Decided on 90% coverage target`,
    `- User likes immutable data structures`,
    ``,
  ].join('\n')

  it('should extract user preferences from rich session', () => {
    writeDailyLog('2026-04-05', richLog)
    const content = readFileSync(join(vaultRoot, 'daily', '2026-04-05.md'), 'utf-8')
    const extracted = extractFromLog(content, '2026-04-05')

    expect(extracted.length).toBeGreaterThanOrEqual(10)

    const userEntries = extracted.filter((e) => e.type === 'user')
    const userContent = userEntries.map((e) => e.content.toLowerCase()).join(' | ')

    // Key preferences should be captured
    expect(userContent).toContain('jwt')
    expect(userContent).toContain('explicit error handling')
    expect(userContent).toContain('silent error swallowing')
    expect(userContent).toContain('named exports')
  })

  it('should extract feedback/remember-to items', () => {
    writeDailyLog('2026-04-05', richLog)
    const content = readFileSync(join(vaultRoot, 'daily', '2026-04-05.md'), 'utf-8')
    const extracted = extractFromLog(content, '2026-04-05')

    const feedbackEntries = extracted.filter((e) => e.type === 'feedback')
    const fbContent = feedbackEntries.map((e) => e.content.toLowerCase()).join(' | ')

    expect(feedbackEntries.length).toBeGreaterThanOrEqual(2)
    expect(fbContent).toContain('validate all inputs with zod')
  })

  it('should extract reference entries with URLs', () => {
    writeDailyLog('2026-04-05', richLog)
    const content = readFileSync(join(vaultRoot, 'daily', '2026-04-05.md'), 'utf-8')
    const extracted = extractFromLog(content, '2026-04-05')

    const refEntries = extracted.filter((e) => e.type === 'reference')
    const refContent = refEntries.map((e) => e.content).join(' | ')

    expect(refEntries.length).toBeGreaterThanOrEqual(2)
    expect(refContent).toContain('https://docs.example.com/auth')
    expect(refContent).toContain('https://monitoring.example.com/auth')
  })

  it('should extract project decisions', () => {
    writeDailyLog('2026-04-05', richLog)
    const content = readFileSync(join(vaultRoot, 'daily', '2026-04-05.md'), 'utf-8')
    const extracted = extractFromLog(content, '2026-04-05')

    const projectEntries = extracted.filter((e) => e.type === 'project')
    const projContent = projectEntries.map((e) => e.content.toLowerCase()).join(' | ')

    expect(projectEntries.length).toBeGreaterThanOrEqual(2)
    expect(projContent).toContain('bcrypt')
  })

  it('should produce valid MEMORY.md when rich session is consolidated', () => {
    writeDailyLog('2026-04-05', richLog)
    const content = readFileSync(join(vaultRoot, 'daily', '2026-04-05.md'), 'utf-8')
    const extracted = extractFromLog(content, '2026-04-05')

    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries: extracted,
      referenceDate: new Date('2026-04-06T00:00:00Z'),
    })

    // Should produce valid, parseable MEMORY.md
    const reparsed = parseMemoryMd(result.memoryMd)
    expect(reparsed.length).toBe(result.entriesKept)

    // User entries should be prioritized first
    if (reparsed.length > 0) {
      expect(reparsed[0]!.type).toBe('user')
    }
  })
})

// ===========================================================================
// 4. Idempotency
// ===========================================================================

describe('Idempotency', () => {
  it('should produce same output when re-run with no new entries', () => {
    const extracted = extractAllLogs(FIVE_DAY_LOGS)
    const refDate = new Date('2026-04-06T00:00:00Z')

    const result1 = runConsolidation({
      currentMemoryMd: '',
      newEntries: extracted,
      referenceDate: refDate,
    })

    // Run again with the consolidated output and no new entries
    const result2 = runConsolidation({
      currentMemoryMd: result1.memoryMd,
      newEntries: [],
      referenceDate: refDate,
    })

    expect(result2.memoryMd).toBe(result1.memoryMd)
    expect(result2.entriesKept).toBe(result1.entriesKept)
  })

  it('should not duplicate entries when same entries are added again', () => {
    const extracted = extractAllLogs(FIVE_DAY_LOGS)
    const refDate = new Date('2026-04-06T00:00:00Z')

    const result1 = runConsolidation({
      currentMemoryMd: '',
      newEntries: extracted,
      referenceDate: refDate,
    })

    // Run again with the same new entries on top of existing MEMORY.md
    const result2 = runConsolidation({
      currentMemoryMd: result1.memoryMd,
      newEntries: extracted,
      referenceDate: refDate,
    })

    // Should not have more entries than the first run (duplicates removed)
    expect(result2.entriesKept).toBeLessThanOrEqual(result1.entriesKept)
    expect(result2.duplicatesRemoved + result2.contradictionsResolved).toBeGreaterThan(0)
  })

  it('should be stable across multiple consolidation rounds', () => {
    const extracted = extractAllLogs(FIVE_DAY_LOGS)
    const refDate = new Date('2026-04-06T00:00:00Z')

    // Round 1: initial
    const r1 = runConsolidation({
      currentMemoryMd: '',
      newEntries: extracted,
      referenceDate: refDate,
    })

    // Round 2: re-consolidate with no new data
    const r2 = runConsolidation({
      currentMemoryMd: r1.memoryMd,
      newEntries: [],
      referenceDate: refDate,
    })

    // Round 3: one more round
    const r3 = runConsolidation({
      currentMemoryMd: r2.memoryMd,
      newEntries: [],
      referenceDate: refDate,
    })

    expect(r3.memoryMd).toBe(r2.memoryMd)
    expect(r3.memoryMd).toBe(r1.memoryMd)
  })
})

// ===========================================================================
// 5. Concurrent lock prevention
// ===========================================================================

describe('Concurrent lock prevention', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initDreamState(db)
  })

  afterEach(() => {
    db.close()
  })

  it('should fail gate check when lock is held', () => {
    // Set up state so time + count gates pass
    recordDreamRun(db, { durationMs: 100, entriesProcessed: 5 })
    // Push last_run_at far into the past
    db.prepare(`UPDATE dream_state SET last_run_at = datetime('now', '-2 days') WHERE id = 1`).run()
    for (let i = 0; i < 10; i++) incrementSessionCount(db)

    // Gates should pass before lock
    const before = checkDreamGates(db, {
      minTimeSinceLastRunMs: 86_400_000,
      minSessionsSinceLastRun: 5,
      staleLockMs: 5 * 86_400_000,
    })
    expect(before.canRun).toBe(true)

    // Acquire lock
    const locked = acquireDreamLock(db, 'test-holder-1')
    expect(locked).toBe(true)

    // Gates should now fail with 'lock'
    const during = checkDreamGates(db, {
      minTimeSinceLastRunMs: 86_400_000,
      minSessionsSinceLastRun: 5,
      staleLockMs: 5 * 86_400_000,
    })
    expect(during.canRun).toBe(false)
    expect(during.failedGate).toBe('lock')

    // Release lock
    const released = releaseDreamLock(db, 'test-holder-1')
    expect(released).toBe(true)

    // Gates should pass again
    const after = checkDreamGates(db, {
      minTimeSinceLastRunMs: 86_400_000,
      minSessionsSinceLastRun: 5,
      staleLockMs: 5 * 86_400_000,
    })
    expect(after.canRun).toBe(true)
  })

  it('should prevent second lock acquisition', () => {
    const first = acquireDreamLock(db, 'holder-A')
    expect(first).toBe(true)

    const second = acquireDreamLock(db, 'holder-B')
    expect(second).toBe(false)

    // Verify state shows holder-A
    const state = getDreamState(db)
    expect(state!.lock_holder).toBe('holder-A')
  })

  it('should only allow holder to release lock', () => {
    acquireDreamLock(db, 'holder-A')

    // Wrong holder cannot release
    const wrongRelease = releaseDreamLock(db, 'holder-B')
    expect(wrongRelease).toBe(false)

    // Correct holder can release
    const rightRelease = releaseDreamLock(db, 'holder-A')
    expect(rightRelease).toBe(true)

    // State should be unlocked
    const state = getDreamState(db)
    expect(state!.lock_holder).toBeNull()
  })

  it('should respect time gate', () => {
    // Record a run just now — time gate should fail
    recordDreamRun(db, { durationMs: 50, entriesProcessed: 3 })
    for (let i = 0; i < 10; i++) incrementSessionCount(db)

    const result = checkDreamGates(db, {
      minTimeSinceLastRunMs: 86_400_000, // 24h
      minSessionsSinceLastRun: 5,
      staleLockMs: 5 * 86_400_000,
    })

    expect(result.canRun).toBe(false)
    expect(result.failedGate).toBe('time')
  })

  it('should respect count gate', () => {
    // Record a run in the past, but not enough sessions
    recordDreamRun(db, { durationMs: 50, entriesProcessed: 3 })
    db.prepare(`UPDATE dream_state SET last_run_at = datetime('now', '-2 days') WHERE id = 1`).run()
    // Only 2 sessions, need 5
    incrementSessionCount(db)
    incrementSessionCount(db)

    const result = checkDreamGates(db, {
      minTimeSinceLastRunMs: 86_400_000,
      minSessionsSinceLastRun: 5,
      staleLockMs: 5 * 86_400_000,
    })

    expect(result.canRun).toBe(false)
    expect(result.failedGate).toBe('count')
  })
})

// ===========================================================================
// 6. Large input handling
// ===========================================================================

describe('Large input handling', () => {
  it('should handle 30+ daily logs and stay within MEMORY.md limits', () => {
    // Construct diverse entries directly to test consolidation at scale
    // (extraction is already tested separately; this tests the pipeline limits)
    const entries: MemoryEntry[] = []

    for (let i = 0; i < 120; i++) {
      const day = (i % 30) + 1
      const dd = String(day).padStart(2, '0')
      const types: MemoryEntry['type'][] = ['user', 'feedback', 'project', 'reference']
      const type = types[i % 4]!
      entries.push({
        type,
        name: `Entry ${type} number ${i}`,
        description: `Description for unique entry ${i} of type ${type}`,
        content: `Content for unique entry ${i} covering a specific topic about item ${i}`,
        source: `daily-log:2026-04-${dd}`,
        createdAt: `2026-04-${dd}T10:${String(i % 60).padStart(2, '0')}:00Z`,
      })
    }

    expect(entries.length).toBe(120)

    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries: entries,
      referenceDate: new Date('2026-05-01T00:00:00Z'),
    })

    // Must fit within limits
    expect(countLines(result.memoryMd)).toBeLessThanOrEqual(MAX_ENTRYPOINT_LINES)
    expect(countBytes(result.memoryMd)).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)

    // Should have kept some entries
    expect(result.entriesKept).toBeGreaterThan(0)

    // Re-parse to verify validity
    const reparsed = parseMemoryMd(result.memoryMd)
    expect(reparsed.length).toBe(result.entriesKept)
  })

  it('should prioritize user preferences over references when pruning', () => {
    const logs: Array<{ date: string; content: string }> = []

    // Generate lots of entries to force pruning
    for (let day = 1; day <= 30; day++) {
      const dd = String(day).padStart(2, '0')
      const date = `2026-04-${dd}`
      logs.push({
        date,
        content: [
          `## ${date}`,
          ``,
          `### 10:00 — Session s${day}`,
          `- User prefers approach-${day} for styling`,
          `- Docs at https://docs-${day}.example.com/guide`,
          `- User likes method-${day} for error handling`,
          `- Dashboard at https://dash-${day}.example.com`,
          ``,
        ].join('\n'),
      })
    }

    const extracted = extractAllLogs(logs)
    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries: extracted,
      referenceDate: new Date('2026-05-01T00:00:00Z'),
    })

    const entries = parseMemoryMd(result.memoryMd)
    const userCount = entries.filter((e) => e.type === 'user').length
    const refCount = entries.filter((e) => e.type === 'reference').length

    // User entries should be preserved more than references
    expect(userCount).toBeGreaterThanOrEqual(refCount)
  })

  it('should not crash or hang on very large input', () => {
    // Construct 200+ unique entries to stress-test the pipeline
    const types: MemoryEntry['type'][] = ['user', 'feedback', 'project', 'reference']
    const entries: MemoryEntry[] = []

    for (let i = 0; i < 250; i++) {
      const type = types[i % 4]!
      const day = (i % 30) + 1
      const dd = String(day).padStart(2, '0')
      entries.push({
        type,
        name: `Unique item ${i} of kind ${type}`,
        description: `Detailed description for item number ${i}`,
        content: `Specific content for entry ${i} about unique topic ${i}`,
        source: `daily-log:2026-04-${dd}`,
        createdAt: `2026-04-${dd}T${String(10 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
      })
    }

    expect(entries.length).toBe(250)

    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries: entries,
      referenceDate: new Date('2026-06-01T00:00:00Z'),
    })

    // Should complete without error, respecting limits
    expect(countLines(result.memoryMd)).toBeLessThanOrEqual(MAX_ENTRYPOINT_LINES)
    expect(countBytes(result.memoryMd)).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)
    expect(result.entriesKept).toBeGreaterThan(0)
  })
})

// ===========================================================================
// 7. Empty / edge cases
// ===========================================================================

describe('Empty and edge cases', () => {
  it('should produce empty result with no daily logs', () => {
    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries: [],
      referenceDate: new Date('2026-04-06T00:00:00Z'),
    })

    expect(result.memoryMd).toBe('')
    expect(result.entriesKept).toBe(0)
    expect(result.entriesProcessed).toBe(0)
  })

  it('should produce empty extraction from logs with only routine actions', () => {
    const routineLog = {
      date: '2026-04-05',
      content: [
        `## 2026-04-05`,
        ``,
        `### 10:00 — Session routine`,
        `- Opened the project in VS Code`,
        `- Read the README file`,
        `- Checked the CI pipeline status`,
        `- Looked at the pull request comments`,
        `- Ran the existing test suite`,
        ``,
      ].join('\n'),
    }

    writeDailyLog(routineLog.date, routineLog.content)
    const content = readFileSync(join(vaultRoot, 'daily', `${routineLog.date}.md`), 'utf-8')
    const extracted = extractFromLog(content, routineLog.date)

    // Routine actions with no keywords should produce no classifiable entries
    expect(extracted.length).toBe(0)
  })

  it('should leave existing MEMORY.md unchanged when no new logs exist', () => {
    // First, create an existing MEMORY.md
    const existingEntries: MemoryEntry[] = [
      {
        type: 'user',
        name: 'User Prefers TypeScript',
        description: 'User prefers TypeScript over JavaScript',
        content: 'User prefers TypeScript over JavaScript',
        source: 'daily-log:2026-04-01',
        createdAt: '2026-04-01T10:00:00Z',
      },
      {
        type: 'project',
        name: 'Decided To Use PostgreSQL',
        description: 'Decided to use PostgreSQL for database',
        content: 'Decided to use PostgreSQL for database',
        source: 'daily-log:2026-04-02',
        createdAt: '2026-04-02T09:30:00Z',
      },
    ]
    const existingMd = serializeMemoryMd(existingEntries)

    const result = runConsolidation({
      currentMemoryMd: existingMd,
      newEntries: [],
      referenceDate: new Date('2026-04-06T00:00:00Z'),
    })

    // Content should be preserved
    expect(result.entriesKept).toBe(2)
    expect(result.duplicatesRemoved).toBe(0)
    expect(result.contradictionsResolved).toBe(0)

    const reparsed = parseMemoryMd(result.memoryMd)
    expect(reparsed.length).toBe(2)
    expect(reparsed.some((e) => e.name === 'User Prefers TypeScript')).toBe(true)
    expect(reparsed.some((e) => e.name === 'Decided To Use PostgreSQL')).toBe(true)
  })

  it('should handle empty daily log files gracefully', () => {
    writeDailyLog('2026-04-05', '')
    const content = readFileSync(join(vaultRoot, 'daily', '2026-04-05.md'), 'utf-8')
    const extracted = extractFromLog(content, '2026-04-05')
    expect(extracted).toEqual([])
  })

  it('should handle daily log with only a date header', () => {
    writeDailyLog('2026-04-05', '## 2026-04-05\n')
    const content = readFileSync(join(vaultRoot, 'daily', '2026-04-05.md'), 'utf-8')
    const extracted = extractFromLog(content, '2026-04-05')
    expect(extracted).toEqual([])
  })

  it('should handle single entry gracefully', () => {
    const singleLog = {
      date: '2026-04-05',
      content: `## 2026-04-05\n\n### 10:00 — Session s1\n- User prefers dark mode\n`,
    }

    writeDailyLog(singleLog.date, singleLog.content)
    const content = readFileSync(join(vaultRoot, 'daily', `${singleLog.date}.md`), 'utf-8')
    const extracted = extractFromLog(content, singleLog.date)

    expect(extracted.length).toBe(1)

    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries: extracted,
      referenceDate: new Date('2026-04-06T00:00:00Z'),
    })

    expect(result.entriesKept).toBe(1)
    const entries = parseMemoryMd(result.memoryMd)
    expect(entries[0]!.content.toLowerCase()).toContain('dark mode')
  })
})

// ===========================================================================
// 8. End-to-end: filesystem round-trip
// ===========================================================================

describe('Filesystem round-trip', () => {
  it('should write MEMORY.md to disk and read it back identically', () => {
    const extracted = extractAllLogs(FIVE_DAY_LOGS)
    const result = runConsolidation({
      currentMemoryMd: '',
      newEntries: extracted,
      referenceDate: new Date('2026-04-06T00:00:00Z'),
    })

    // Write to disk
    const memoryPath = join(vaultRoot, 'MEMORY.md')
    writeFileSync(memoryPath, result.memoryMd, 'utf-8')

    // Read back
    const readBack = readFileSync(memoryPath, 'utf-8')
    expect(readBack).toBe(result.memoryMd)

    // Parse the file from disk
    const reparsed = parseMemoryMd(readBack)
    expect(reparsed.length).toBe(result.entriesKept)
  })

  it('should handle incremental consolidation over multiple days', () => {
    const refDate = new Date('2026-04-06T00:00:00Z')

    // Day 1-2: initial consolidation
    const firstBatch = FIVE_DAY_LOGS.slice(0, 2)
    const extracted1 = extractAllLogs(firstBatch)
    const result1 = runConsolidation({
      currentMemoryMd: '',
      newEntries: extracted1,
      referenceDate: refDate,
    })

    // Write MEMORY.md
    const memoryPath = join(vaultRoot, 'MEMORY.md')
    writeFileSync(memoryPath, result1.memoryMd, 'utf-8')

    // Day 3-5: incremental consolidation
    const secondBatch = FIVE_DAY_LOGS.slice(2)
    const extracted2 = extractAllLogs(secondBatch)
    const existingMd = readFileSync(memoryPath, 'utf-8')

    const result2 = runConsolidation({
      currentMemoryMd: existingMd,
      newEntries: extracted2,
      referenceDate: refDate,
    })

    // Should have more entries than either batch alone
    expect(result2.entriesKept).toBeGreaterThanOrEqual(result1.entriesKept)

    // Re-parse to verify validity
    const reparsed = parseMemoryMd(result2.memoryMd)
    expect(reparsed.length).toBe(result2.entriesKept)
  })
})

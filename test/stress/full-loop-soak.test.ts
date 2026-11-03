/**
 * Phase 13.8 — Full-loop soak harness.
 *
 * Feeds 10 consecutive synthetic suggestions through the entire PASS path
 * (team_completed → arbiter → branch commit on scns/auto/<slug>) against a
 * single long-lived broker + git repo, asserting:
 *
 *   - Every loop persists a quality_checks row with passed=1
 *   - A distinct scns/auto/<slug> branch is committed per loop
 *   - The corresponding suggestion transitions to `implemented`
 *   - Peak process RSS stays under 500 MB
 *   - No child processes / lingering handles (skipCommands=true; arbiter spawns
 *     no external processes, only invokes git directly via execSync)
 *
 * The harness runs with `skipCommands: true` so each loop is fast (~100 ms) —
 * this is about plumbing robustness, not re-testing the Phase 13.5 rubric.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import {
  createQualityGateArbiter,
  type QualityGateArbiter,
} from '../../src/broker/services/quality-gate-arbiter.js'
import { createSuggestionStore } from '../../src/suggest/suggestion-store.js'
import { createVault } from '../../src/memory/vault.js'
import { createNegativeMemoryStore } from '../../src/memory/negative-memory-store.js'
import type { Suggestion } from '../../src/suggest/types.js'

const LOOP_COUNT = 10
const MAX_PEAK_RSS_BYTES = 500 * 1024 * 1024

function initProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scns-soak-root-'))
  execSync('git init --quiet -b main', { cwd: dir })
  execSync('git config user.email "scns-soak@localhost"', { cwd: dir })
  execSync('git config user.name "scns-soak"', { cwd: dir })
  execSync('git commit --quiet --allow-empty -m "initial"', { cwd: dir })
  return dir
}

function makeSuggestion(i: number): Suggestion {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    type: 'skill',
    title: `soak-suggestion-${i}`,
    description: `Soak loop iteration ${i}`,
    status: 'pending',
    confidence: 0.9,
    evidence: [
      { source: 'soak', detail: `iter-${i}`, observedAt: now, weight: 0.5 },
    ],
    tags: ['soak'],
    createdAt: now,
    updatedAt: now,
    actionable: true,
    estimatedComplexity: 'solo',
  } as Suggestion
}

function makeNewFileDiff(filename: string, body: string): string {
  const bodyLines = body.split('\n')
  return [
    `diff --git a/${filename} b/${filename}`,
    `new file mode 100644`,
    `index 0000000..1111111`,
    `--- /dev/null`,
    `+++ b/${filename}`,
    `@@ -0,0 +1,${bodyLines.length} @@`,
    bodyLines.map((l) => '+' + l).join('\n'),
    '',
  ].join('\n')
}

describe('Phase 13.8 full-loop soak harness', { timeout: 120_000 }, () => {
  let tmpRoot: string
  let projectRoot: string
  let db: Database.Database
  let dispatcher: ReturnType<typeof createEventDispatcher>
  let eventLog: ReturnType<typeof createEventLog>
  let suggestionStore: ReturnType<typeof createSuggestionStore>
  let vault: ReturnType<typeof createVault>
  let negMem: ReturnType<typeof createNegativeMemoryStore>
  let arbiter: QualityGateArbiter
  let initialActiveHandles: number

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'scns-soak-'))
    projectRoot = initProjectRoot()
    db = openDatabase(':memory:')
    dispatcher = createEventDispatcher()
    eventLog = createEventLog(db, dispatcher)
    suggestionStore = createSuggestionStore({ rootDir: join(tmpRoot, 'suggestions') })
    vault = createVault({ rootDir: join(tmpRoot, 'vault') })
    negMem = createNegativeMemoryStore(vault)
    arbiter = createQualityGateArbiter({
      db,
      eventLog,
      dispatcher,
      projectRoot,
      suggestionStore: {
        get: (id) => suggestionStore.get(id),
        updateStatus: (id, status, reason) =>
          suggestionStore.updateStatus(id, status, reason),
      },
      negativeMemoryStore: negMem,
      skipCommands: true,
      worktreeBase: tmpRoot,
    })

    // Record active handles baseline (non-standard API, best-effort).
    const getHandles = (process as unknown as {
      _getActiveHandles?: () => unknown[]
    })._getActiveHandles
    initialActiveHandles = getHandles ? getHandles().length : 0
  })

  afterAll(async () => {
    arbiter.stop()
    closeDatabase(db)
    // Clean up any leftover branches so the soak doesn't pollute other tests.
    try {
      const out = execSync('git branch --list "scns/auto/*"', {
        cwd: projectRoot,
        encoding: 'utf8',
      })
      for (const line of out.split('\n')) {
        const b = line.replace(/^\*?\s*/, '').trim()
        if (b.startsWith('scns/auto/')) {
          try {
            execSync(`git branch -D ${b}`, { cwd: projectRoot, stdio: 'ignore' })
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it(`runs ${LOOP_COUNT} consecutive PASS loops with no leaks and stable memory`, async () => {
    const rssSamples: number[] = []
    const branches: string[] = []
    const suggestionIds: string[] = []

    for (let i = 0; i < LOOP_COUNT; i++) {
      const sugg = makeSuggestion(i)
      suggestionStore.save(sugg)
      suggestionIds.push(sugg.id)

      const teamId = `team-task-sugg-${sugg.id}`
      const diff = makeNewFileDiff(
        `soak-${i}-${sugg.id.slice(0, 8)}.txt`,
        `Soak iteration ${i} artifact.`,
      )

      const verdict = await arbiter.handleTeamCompletion({
        teamId,
        memberSessionIds: [`soak-agent-${i}`],
        stagedDiff: diff,
        artifacts: [],
        logs: [],
        aggregateOutcome: 'success',
        completedAt: new Date().toISOString(),
      })
      expect(verdict.passed).toBe(true)
      expect(verdict.branch).toMatch(/^scns\/auto\//)
      branches.push(verdict.branch!)

      rssSamples.push(process.memoryUsage().rss)
    }

    // Every loop produced a quality_checks row (PASS).
    const passCount = db
      .prepare('SELECT COUNT(*) AS n FROM quality_checks WHERE passed = 1')
      .get() as { n: number }
    expect(passCount.n).toBeGreaterThanOrEqual(LOOP_COUNT)

    // Every branch is unique and actually exists in the repo.
    expect(new Set(branches).size).toBe(LOOP_COUNT)
    const branchList = execSync('git branch --list "scns/auto/*"', {
      cwd: projectRoot,
      encoding: 'utf8',
    })
    for (const b of branches) expect(branchList).toContain(b)

    // Every source suggestion is now `implemented`.
    for (const id of suggestionIds) {
      const after = suggestionStore.get(id)
      expect(after, `suggestion ${id}`).not.toBeNull()
      expect(after!.status).toBe('implemented')
    }

    // Peak memory stays under the budget.
    const peakRss = Math.max(...rssSamples)
    expect(peakRss).toBeLessThan(MAX_PEAK_RSS_BYTES)

    // No active-handle growth from the arbiter/dispatcher chain.
    const getHandles = (process as unknown as {
      _getActiveHandles?: () => unknown[]
    })._getActiveHandles
    if (getHandles) {
      const finalHandles = getHandles().length
      // Allow a small delta for vitest internals.
      expect(finalHandles - initialActiveHandles).toBeLessThanOrEqual(5)
    }

    // DB lock contention smoke: rapid read while writes were just committed.
    const quickRead = db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE event_type = ?')
      .get('quality_gate_verdict') as { n: number }
    expect(quickRead.n).toBeGreaterThanOrEqual(LOOP_COUNT)
  })
})

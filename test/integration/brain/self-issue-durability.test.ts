/**
 * Bug 2 durability — end-to-end composition test.
 *
 * Reproduces the exact live fixture (child broker had 4 issues persistently
 * flagged `self-issue:ingested:*` at enqueue, then a restart lost the in-memory
 * tasks) against a REAL better-sqlite3 `shared_state` table, driving the real
 * self-issue-source + self-issue-tracker + a stand-in in-memory queue exactly as
 * cli.ts wires them. Proves: the 4 stranded issues become recoverable WITHOUT
 * hand-clearing the legacy keys, survive a restart, don't duplicate while leased,
 * go terminal on team success, and recover from a crash-during-work via the
 * stale-lease sweep.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createSelfIssueTracker, selfIssueTeamId } from '../../../src/brain/self-issue-tracker.js'
import {
  handleSelfIssueTeamCompletion,
  handleSelfIssueGateVerdict,
} from '../../../src/brain/self-issue-completion.js'
import {
  createSelfIssueSource,
  type SelfIssueSignal,
} from '../../../src/brain/self-issue-source.js'
import { DecisionPriority } from '../../../src/brain/state-types.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE shared_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      story_id TEXT,
      session_id TEXT,
      updated_at DATETIME DEFAULT (datetime('now'))
    );
  `)
  return db
}

/** The 4 Cosmere issues, as `gh issue list` would return them. */
const COSMERE_ISSUES: SelfIssueSignal[] = [1, 2, 3, 4].map((n) => ({
  key: `github-issue:${n}`,
  kind: 'github-issue',
  title: `Cosmere issue ${n}`,
  url: `https://github.com/example/cosmere-child/issues/${n}`,
  labels: [],
}))

/**
 * Compose the source exactly as cli.ts does: a persistent tracker + an in-memory
 * queue whose membership is checked by `isActive`, and `enqueueTask` threading
 * the signalKey onto the queued item. Returns handles to drive a broker lifecycle.
 */
function wire(db: Database.Database, signals: SelfIssueSignal[]) {
  const tracker = createSelfIssueTracker(db)
  // In-memory queue = the brain taskQueue; lost on "restart".
  let queue: Array<{ id: string; signalKey: string }> = []
  let counter = 0
  const source = createSelfIssueSource(
    {
      fetchSignals: async () => signals,
      isActive: (key) => tracker.isActive(key) || queue.some((t) => t.signalKey === key),
      enqueueTask: (_description, _priority: DecisionPriority, signalKey) => {
        const id = `task-${++counter}`
        queue.push({ id, signalKey })
        return id
      },
    },
    { maxPerRun: 10 }, // raise the per-run bound so all 4 fixture issues flow at once
  )
  return {
    tracker,
    source,
    get queue() {
      return queue
    },
    /** The brain dequeues a task and spawns a unique team, leasing the signal. */
    spawn(signalKey: string): string {
      const idx = queue.findIndex((t) => t.signalKey === signalKey)
      const task = queue[idx]!
      queue.splice(idx, 1)
      const teamId = selfIssueTeamId(task.id)
      tracker.markInProgress(signalKey, teamId)
      return teamId
    },
    /** Simulate a broker restart: the in-memory queue is gone; the db persists. */
    restart(): void {
      queue = []
    },
  }
}

describe('Bug 2 — self-issue durability across a broker restart (fixture repro)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = freshDb()
    // Seed the EXACT stranded fixture: 4 legacy fire-and-forget ingested flags.
    const seed = db.prepare(
      "INSERT INTO shared_state (key, value, updated_at) VALUES (?, '1', datetime('now'))",
    )
    for (const n of [1, 2, 3, 4]) seed.run(`self-issue:ingested:github-issue:${n}`)
  })

  it('the 4 legacy-stranded issues are re-pulled without hand-clearing the old keys', async () => {
    const w = wire(db, COSMERE_ISSUES)
    const r = await w.source.ingest()

    expect(r.ingested).toBe(4)
    expect(w.queue.map((t) => t.signalKey)).toEqual([
      'github-issue:1',
      'github-issue:2',
      'github-issue:3',
      'github-issue:4',
    ])
    // The old keys were never cleared — the fix simply stops honoring them.
    const legacy = db
      .prepare("SELECT COUNT(*) AS c FROM shared_state WHERE key LIKE 'self-issue:ingested:%'")
      .get() as { c: number }
    expect(legacy.c).toBe(4)
  })

  it('a signal enqueued but lost to a restart is re-enqueued (the core bug)', async () => {
    const w = wire(db, COSMERE_ISSUES)
    await w.source.ingest()
    expect(w.queue).toHaveLength(4)

    // Restart before the brain worked any task.
    w.restart()
    expect(w.queue).toHaveLength(0)

    const r2 = await w.source.ingest()
    expect(r2.ingested).toBe(4) // recovered — under the old flag these were gone forever
    expect(w.queue).toHaveLength(4)
  })

  it('does not duplicate a leased (in-progress) issue, and a restart mid-flight does not lose it', async () => {
    const w = wire(db, COSMERE_ISSUES)
    await w.source.ingest()

    // Brain spawns a team for issue 1 → lease persisted.
    w.spawn('github-issue:1')
    // Restart: queue lost, but issue 1's lease persists in the db.
    w.restart()

    const r2 = await w.source.ingest()
    // 1 is leased (skipped); 2,3,4 were lost-before-spawn and are re-enqueued.
    expect(r2.ingested).toBe(3)
    expect(w.queue.map((t) => t.signalKey).sort()).toEqual([
      'github-issue:2',
      'github-issue:3',
      'github-issue:4',
    ])
    expect(w.tracker.isActive('github-issue:1')).toBe(true)
  })

  it('a successful team_completed marks the issue done — never re-enqueued again', async () => {
    const w = wire(db, COSMERE_ISSUES)
    await w.source.ingest()
    const teamId = w.spawn('github-issue:1')

    // team_completed subscriber path (aggregateOutcome === 'success').
    const resolved = w.tracker.findInProgressByTeam(teamId)
    expect(resolved).toBe('github-issue:1')
    w.tracker.markDone(resolved!)

    w.restart()
    const r2 = await w.source.ingest()
    expect(r2.ingested).toBe(3) // only 2,3,4
    expect(w.queue.some((t) => t.signalKey === 'github-issue:1')).toBe(false)
  })

  it('a team_completed (any outcome) does NOT release the lease, so no immediate respawn', async () => {
    const w = wire(db, COSMERE_ISSUES)
    await w.source.ingest()
    const teamId = w.spawn('github-issue:1')

    // The real subscriber path. A self-issue team emits more than one team_completed
    // (once per wave of member sessions that exits); production saw `failed` at ~5min
    // followed by `success` at ~20min for the SAME team. Releasing on the `failed`
    // is what let the next 15-minute tick respawn the issue, forever. scns#36
    // tightened this further: NO member-exit event mutates the lease — the
    // quality-gate verdict for the wave's diff is the only resolver.
    const failed = handleSelfIssueTeamCompletion(w.tracker, {
      teamId,
      aggregateOutcome: 'failed',
    })
    expect(failed.action).toBe('awaiting-gate-verdict')

    w.restart()
    const r2 = await w.source.ingest()
    expect(r2.ingested).toBe(3) // issue 1 is still leased — only 2,3,4
    expect(w.queue.some((t) => t.signalKey === 'github-issue:1')).toBe(false)

    // A clean later wave still does not resolve it (scns#36: the live defect
    // was exactly this success event resolving before the gate ran)…
    const succeeded = handleSelfIssueTeamCompletion(w.tracker, {
      teamId,
      aggregateOutcome: 'success',
    })
    expect(succeeded.action).toBe('awaiting-gate-verdict')
    expect(succeeded.signalKey).toBe('github-issue:1')

    // …the gate verdict is what actually resolves it.
    const verdict = handleSelfIssueGateVerdict(w.tracker, { team_id: teamId, passed: true })
    expect(verdict.action).toBe('resolved')
    expect(verdict.signalKey).toBe('github-issue:1')
    expect(w.tracker.isActive('github-issue:1')).toBe(true) // terminal: done, never re-enqueued
  })

  it('a crash mid-work is recovered by the stale-lease sweep', async () => {
    const w = wire(db, COSMERE_ISSUES)
    await w.source.ingest()

    const now = Date.parse('2026-07-17T12:00:00.000Z')
    // Lease issue 1 90 minutes ago, then the worker "crashed".
    const idx = w.queue.findIndex((t) => t.signalKey === 'github-issue:1')
    const task = w.queue[idx]!
    w.queue.splice(idx, 1)
    w.tracker.markInProgress('github-issue:1', selfIssueTeamId(task.id), now - 90 * 60_000)
    w.restart()

    // Before sweep: issue 1 is (wrongly) still leased.
    expect(w.tracker.isActive('github-issue:1')).toBe(true)
    // Ingest run sweeps leases older than 30m first.
    const swept = w.tracker.sweepStale(30 * 60_000, now)
    expect(swept).toBe(1)

    const r2 = await w.source.ingest()
    expect(r2.ingested).toBe(4) // issue 1 recovered
  })
})

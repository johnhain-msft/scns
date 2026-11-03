/**
 * scns#36 — self-issue lease honesty: the lease must resolve on the QUALITY
 * GATE VERDICT, never on member exit.
 *
 * Observed live 2026-08-10 on the Cosmere child (port 3500, main@2576884):
 * Cosmere #13 (team team-selfissue-task-1786401919067-g6w074) logged
 * `self-issue resolved — team completed successfully` at 22:50:21, and THEN
 * the gate ran and returned `quality_gate_verdict {passed:false,
 * reason:'build-failed'}`. The lease said "done" while zero artifacts ever
 * reached GitHub — the signal was permanently burned (ingest dedup skips
 * "done" forever). Same shape on #12 and #14 (#14 across TWO waves: wave 1
 * failed → retained; wave 2 success → resolved despite two build-failed
 * verdicts).
 *
 * The contract pinned here:
 *   - member exit (`team_completed`) NEVER mutates the lease — it only
 *     observes ('awaiting-gate-verdict');
 *   - the gate verdict (`quality_gate_verdict`) is the ONLY resolver:
 *     PASS ⇒ markDone; FAIL ⇒ lease retained (attempt counter + stale sweep
 *     already bound retries);
 *   - correct under multi-wave completions (one verdict per wave):
 *     first-PASS-wins, a FAIL never terminally closes the signal;
 *   - the attempt cap produces an HONEST terminal state: 'abandoned', never
 *     'done' (evaluateSelfIssueSignalForEnqueue writes it durably at ingest
 *     time, where the decision never-to-retry is actually made).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  createSelfIssueTracker,
  type SelfIssueTracker,
} from '../../../src/brain/self-issue-tracker.js'
import {
  handleSelfIssueTeamCompletion,
  handleSelfIssueGateVerdict,
  evaluateSelfIssueSignalForEnqueue,
} from '../../../src/brain/self-issue-completion.js'

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

describe('handleSelfIssueTeamCompletion — member exit only observes', () => {
  let db: Database.Database
  let tracker: SelfIssueTracker

  beforeEach(() => {
    db = freshDb()
    tracker = createSelfIssueTracker(db)
  })

  it('ignores a completion with no teamId', () => {
    const result = handleSelfIssueTeamCompletion(tracker, {})
    expect(result.action).toBe('not-a-self-issue-team')
    expect(result.signalKey).toBeNull()
  })

  it('ignores a team that holds no self-issue lease (suggestion/A2A teams)', () => {
    const result = handleSelfIssueTeamCompletion(tracker, {
      teamId: 'team-suggestion-1',
      aggregateOutcome: 'success',
    })
    expect(result.action).toBe('not-a-self-issue-team')
  })

  it('scns#36 REGRESSION: a successful member exit does NOT resolve the lease', () => {
    // The defect: aggregateOutcome==='success' used to markDone here, before
    // the gate ever ran. The lease then read "done" against a gate verdict of
    // build-failed — a lease record that contradicts the gate.
    tracker.markInProgress('github-issue:13', 'team-selfissue-task-1786401919067-g6w074')

    const result = handleSelfIssueTeamCompletion(tracker, {
      teamId: 'team-selfissue-task-1786401919067-g6w074',
      aggregateOutcome: 'success',
    })

    expect(result).toEqual({
      action: 'awaiting-gate-verdict',
      signalKey: 'github-issue:13',
    })
    // Lease untouched: still in-progress, still correlated to the team.
    expect(tracker.findInProgressByTeam('team-selfissue-task-1786401919067-g6w074')).toBe(
      'github-issue:13',
    )
    expect(tracker.status('github-issue:13')).toBe('in-progress')
  })

  it('a failed member exit also leaves the lease untouched (stale sweep handles strays)', () => {
    tracker.markInProgress('github-issue:4', 'team-a')

    const result = handleSelfIssueTeamCompletion(tracker, {
      teamId: 'team-a',
      aggregateOutcome: 'failed',
    })

    expect(result).toEqual({ action: 'awaiting-gate-verdict', signalKey: 'github-issue:4' })
    expect(tracker.isActive('github-issue:4')).toBe(true)
    expect(tracker.findInProgressByTeam('team-a')).toBe('github-issue:4')
  })
})

describe('handleSelfIssueGateVerdict — the gate verdict is the only resolver', () => {
  let db: Database.Database
  let tracker: SelfIssueTracker

  beforeEach(() => {
    db = freshDb()
    tracker = createSelfIssueTracker(db)
  })

  it('ignores a verdict with no team id', () => {
    const result = handleSelfIssueGateVerdict(tracker, { passed: true })
    expect(result.action).toBe('not-a-self-issue-team')
    expect(result.signalKey).toBeNull()
  })

  it('ignores a verdict for a team that holds no self-issue lease', () => {
    const result = handleSelfIssueGateVerdict(tracker, {
      team_id: 'team-sugg-12345678',
      passed: true,
    })
    expect(result.action).toBe('not-a-self-issue-team')
  })

  it('gate PASS resolves the signal terminally and resets the attempt counter', () => {
    tracker.markInProgress('github-issue:2', 'team-a')

    const result = handleSelfIssueGateVerdict(tracker, { team_id: 'team-a', passed: true })

    expect(result).toEqual({ action: 'resolved', signalKey: 'github-issue:2' })
    expect(tracker.status('github-issue:2')).toBe('done')
    expect(tracker.findInProgressByTeam('team-a')).toBeNull()
    expect(tracker.attempts('github-issue:2')).toBe(0)
  })

  it('clean member exit + gate FAIL retains the lease, then the sweep releases it for retry', () => {
    tracker.markInProgress('github-issue:13', 'team-g6w074', 1_000_000)

    // Wave exits cleanly…
    handleSelfIssueTeamCompletion(tracker, {
      teamId: 'team-g6w074',
      aggregateOutcome: 'success',
    })
    // …then the gate fails the diff (the live 2026-08-10 sequence).
    const verdict = handleSelfIssueGateVerdict(tracker, {
      team_id: 'team-g6w074',
      passed: false,
    })

    expect(verdict).toEqual({ action: 'lease-retained', signalKey: 'github-issue:13' })
    expect(tracker.status('github-issue:13')).toBe('in-progress')

    // The existing retry machinery still applies: stale sweep reverts the
    // lease to enqueueable, the attempt counter survives the sweep.
    const swept = tracker.sweepStale(90 * 60_000, 1_000_000 + 91 * 60_000)
    expect(swept).toBe(1)
    expect(tracker.isActive('github-issue:13')).toBe(false)
    expect(tracker.attempts('github-issue:13')).toBe(1)
  })

  it('multi-wave (#14 live shape): wave-2 member success + two gate FAILs ⇒ retained, not done', () => {
    tracker.markInProgress('github-issue:14', 'team-qb6d5n')

    // Wave 1: members failed, gate ran on the wave-1 diff and failed.
    handleSelfIssueTeamCompletion(tracker, { teamId: 'team-qb6d5n', aggregateOutcome: 'failed' })
    handleSelfIssueGateVerdict(tracker, { team_id: 'team-qb6d5n', passed: false })
    // Wave 2: members exited cleanly, gate failed again (build-failed).
    handleSelfIssueTeamCompletion(tracker, { teamId: 'team-qb6d5n', aggregateOutcome: 'success' })
    const final = handleSelfIssueGateVerdict(tracker, { team_id: 'team-qb6d5n', passed: false })

    expect(final.action).toBe('lease-retained')
    expect(tracker.status('github-issue:14')).toBe('in-progress')
    expect(tracker.attempts('github-issue:14')).toBe(1)
  })

  it('multi-wave: wave-1 gate FAIL then wave-2 gate PASS ⇒ resolved (verdict-keyed, first-PASS-wins)', () => {
    tracker.markInProgress('github-issue:7', 'team-w')

    handleSelfIssueGateVerdict(tracker, { team_id: 'team-w', passed: false })
    const second = handleSelfIssueGateVerdict(tracker, { team_id: 'team-w', passed: true })

    expect(second.action).toBe('resolved')
    expect(tracker.status('github-issue:7')).toBe('done')
  })

  it('a PASS after the signal is already done is a no-op (idempotent under replayed verdicts)', () => {
    tracker.markInProgress('github-issue:7', 'team-w')
    handleSelfIssueGateVerdict(tracker, { team_id: 'team-w', passed: true })

    const replay = handleSelfIssueGateVerdict(tracker, { team_id: 'team-w', passed: true })

    expect(replay.action).toBe('not-a-self-issue-team')
    expect(tracker.status('github-issue:7')).toBe('done')
  })

  it('a stale verdict for a lease re-taken by a newer team is dropped', () => {
    tracker.markInProgress('github-issue:4', 'team-old')
    tracker.markInProgress('github-issue:4', 'team-new')

    const result = handleSelfIssueGateVerdict(tracker, { team_id: 'team-old', passed: true })

    expect(result.action).toBe('not-a-self-issue-team')
    expect(tracker.findInProgressByTeam('team-new')).toBe('github-issue:4')
  })
})

describe('evaluateSelfIssueSignalForEnqueue — honest abandonment at the cap', () => {
  let db: Database.Database
  let tracker: SelfIssueTracker

  beforeEach(() => {
    db = freshDb()
    tracker = createSelfIssueTracker(db)
  })

  it('a signal with no record and no attempts is enqueueable', () => {
    expect(evaluateSelfIssueSignalForEnqueue(tracker, 'github-issue:2', 3, false)).toBe(
      'enqueueable',
    )
  })

  it('a leased or done signal is skipped', () => {
    tracker.markInProgress('github-issue:2', 'team-a')
    expect(evaluateSelfIssueSignalForEnqueue(tracker, 'github-issue:2', 3, false)).toBe(
      'leased-or-done',
    )
    tracker.markDone('github-issue:2')
    expect(evaluateSelfIssueSignalForEnqueue(tracker, 'github-issue:2', 3, false)).toBe(
      'leased-or-done',
    )
  })

  it('a signal already sitting in the in-memory queue is skipped', () => {
    expect(evaluateSelfIssueSignalForEnqueue(tracker, 'github-issue:2', 3, true)).toBe('queued')
  })

  it('cap reached ⇒ durably ABANDONED (not done), exactly once', () => {
    // Three attempts burned (spawn → gate-fail → sweep, three times over).
    for (let i = 1; i <= 3; i++) {
      tracker.markInProgress('github-issue:3', `team-${i}`, 1_000_000 * i)
      handleSelfIssueGateVerdict(tracker, { team_id: `team-${i}`, passed: false })
      tracker.sweepStale(0, 1_000_000 * i + 1)
    }
    expect(tracker.attempts('github-issue:3')).toBe(3)
    expect(tracker.isActive('github-issue:3')).toBe(false)

    const disposition = evaluateSelfIssueSignalForEnqueue(tracker, 'github-issue:3', 3, false)

    expect(disposition).toBe('abandoned')
    // HONEST terminal state: abandoned, never 'done'.
    expect(tracker.status('github-issue:3')).toBe('abandoned')
    // The attempt trail is preserved for the audit.
    expect(tracker.attempts('github-issue:3')).toBe(3)
    // Subsequent ticks short-circuit on the durable record — the loud log
    // fires exactly once (on the 'abandoned' disposition), even across
    // broker restarts.
    expect(evaluateSelfIssueSignalForEnqueue(tracker, 'github-issue:3', 3, false)).toBe(
      'leased-or-done',
    )
  })

  it('a cap of 0 disables the guard', () => {
    tracker.markInProgress('github-issue:5', 'team-a')
    tracker.sweepStale(0, Date.now() + 1)
    expect(evaluateSelfIssueSignalForEnqueue(tracker, 'github-issue:5', 0, false)).toBe(
      'enqueueable',
    )
  })
})

describe('tracker abandonment primitives', () => {
  let db: Database.Database
  let tracker: SelfIssueTracker

  beforeEach(() => {
    db = freshDb()
    tracker = createSelfIssueTracker(db)
  })

  it('markAbandoned is terminal: active, not team-correlated, never swept', () => {
    tracker.markInProgress('github-issue:9', 'team-x', 1_000_000)
    tracker.sweepStale(0, 1_000_001)
    tracker.markAbandoned('github-issue:9')

    expect(tracker.status('github-issue:9')).toBe('abandoned')
    expect(tracker.isActive('github-issue:9')).toBe(true)
    expect(tracker.findInProgressByTeam('team-x')).toBeNull()
    // The stale sweep must never revert an abandoned signal to enqueueable.
    expect(tracker.sweepStale(0, Date.now() + 10_000_000)).toBe(0)
    expect(tracker.status('github-issue:9')).toBe('abandoned')
  })

  it('a gate PASS cannot resurrect an abandoned signal', () => {
    tracker.markInProgress('github-issue:9', 'team-x')
    tracker.markAbandoned('github-issue:9')

    const result = handleSelfIssueGateVerdict(tracker, { team_id: 'team-x', passed: true })

    expect(result.action).toBe('not-a-self-issue-team')
    expect(tracker.status('github-issue:9')).toBe('abandoned')
  })

  it('clear() is the documented manual recovery for an abandoned signal', () => {
    tracker.markInProgress('github-issue:9', 'team-x')
    tracker.markAbandoned('github-issue:9')

    tracker.clear('github-issue:9')

    expect(tracker.status('github-issue:9')).toBeNull()
    expect(tracker.isActive('github-issue:9')).toBe(false)
    expect(tracker.attempts('github-issue:9')).toBe(0)
  })
})

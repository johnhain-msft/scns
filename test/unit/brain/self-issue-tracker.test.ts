import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  createSelfIssueTracker,
  selfIssueTeamId,
  type SelfIssueTracker,
} from '../../../src/brain/self-issue-tracker.js'

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

describe('selfIssueTeamId', () => {
  it('is deterministic and unique-per-task with a recognizable prefix', () => {
    expect(selfIssueTeamId('task-abc')).toBe('team-selfissue-task-abc')
    expect(selfIssueTeamId('task-abc')).toBe(selfIssueTeamId('task-abc'))
    expect(selfIssueTeamId('task-1')).not.toBe(selfIssueTeamId('task-2'))
  })
})

describe('createSelfIssueTracker', () => {
  let db: Database.Database
  let tracker: SelfIssueTracker

  beforeEach(() => {
    db = freshDb()
    tracker = createSelfIssueTracker(db)
  })

  it('an unknown signal is NOT active (enqueueable)', () => {
    expect(tracker.isActive('github-issue:1')).toBe(false)
  })

  it('markInProgress leases the signal (active) and records the teamId', () => {
    tracker.markInProgress('github-issue:1', 'team-selfissue-task-1')
    expect(tracker.isActive('github-issue:1')).toBe(true)
    expect(tracker.findInProgressByTeam('team-selfissue-task-1')).toBe('github-issue:1')
  })

  it('markDone is terminal — the signal stays active (never re-enqueued)', () => {
    tracker.markInProgress('github-issue:2', 'team-selfissue-task-2')
    tracker.markDone('github-issue:2')
    expect(tracker.isActive('github-issue:2')).toBe(true)
    // Once done it is no longer an in-progress lease, so team lookup misses.
    expect(tracker.findInProgressByTeam('team-selfissue-task-2')).toBeNull()
  })

  it('clear reverts a signal to enqueueable', () => {
    tracker.markInProgress('github-issue:3', 'team-selfissue-task-3')
    tracker.clear('github-issue:3')
    expect(tracker.isActive('github-issue:3')).toBe(false)
    expect(tracker.findInProgressByTeam('team-selfissue-task-3')).toBeNull()
  })

  it('findInProgressByTeam returns null for an unknown team', () => {
    expect(tracker.findInProgressByTeam('team-selfissue-nope')).toBeNull()
  })

  // F1 — the gate-pass publisher resolves a verdict's source issue AFTER the
  // lease resolver may already have marked it done, so the lookup must be
  // status-agnostic (markDone/markAbandoned preserve teamId for exactly this).
  it('findByTeam matches the lease regardless of status (in-progress, done, abandoned)', () => {
    tracker.markInProgress('github-issue:8', 'team-selfissue-task-8')
    expect(tracker.findByTeam('team-selfissue-task-8')).toBe('github-issue:8')
    tracker.markDone('github-issue:8')
    expect(tracker.findByTeam('team-selfissue-task-8')).toBe('github-issue:8')
    expect(tracker.findInProgressByTeam('team-selfissue-task-8')).toBeNull()

    tracker.markInProgress('github-issue:9', 'team-selfissue-task-9')
    tracker.markAbandoned('github-issue:9')
    expect(tracker.findByTeam('team-selfissue-task-9')).toBe('github-issue:9')
  })

  it('findByTeam returns null for an unknown team', () => {
    expect(tracker.findByTeam('team-selfissue-nope')).toBeNull()
  })

  it('sweepStale reverts in-progress leases older than the TTL (crash-during-work recovery)', () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z')
    tracker.markInProgress('github-issue:4', 'team-selfissue-task-4', now - 40 * 60_000) // 40m old
    tracker.markInProgress('github-issue:5', 'team-selfissue-task-5', now - 5 * 60_000) //  5m old

    const swept = tracker.sweepStale(30 * 60_000, now)

    expect(swept).toBe(1)
    expect(tracker.isActive('github-issue:4')).toBe(false) // stale → enqueueable again
    expect(tracker.isActive('github-issue:5')).toBe(true) // still leased
  })

  it('sweepStale never reverts a done (terminal) record', () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z')
    tracker.markInProgress('github-issue:6', 'team-selfissue-task-6', now - 90 * 60_000)
    tracker.markDone('github-issue:6')

    tracker.sweepStale(30 * 60_000, now + 120 * 60_000)

    expect(tracker.isActive('github-issue:6')).toBe(true)
  })

  it('leases survive a new tracker over the same db (restart durability)', () => {
    tracker.markInProgress('github-issue:7', 'team-selfissue-task-7')
    const reopened = createSelfIssueTracker(db)
    expect(reopened.isActive('github-issue:7')).toBe(true)
    expect(reopened.findInProgressByTeam('team-selfissue-task-7')).toBe('github-issue:7')
  })
})

describe('createSelfIssueTracker — attempt cap (runaway-loop guard)', () => {
  let db: Database.Database
  let tracker: SelfIssueTracker

  beforeEach(() => {
    db = freshDb()
    tracker = createSelfIssueTracker(db)
  })

  it('counts one attempt per spawn', () => {
    expect(tracker.attempts('github-issue:1')).toBe(0)
    tracker.markInProgress('github-issue:1', 'team-a')
    expect(tracker.attempts('github-issue:1')).toBe(1)
    tracker.markInProgress('github-issue:1', 'team-b')
    expect(tracker.attempts('github-issue:1')).toBe(2)
  })

  it('is exhausted once attempts reach the cap', () => {
    tracker.markInProgress('github-issue:2', 'team-a')
    tracker.markInProgress('github-issue:2', 'team-b')
    expect(tracker.isExhausted('github-issue:2', 3)).toBe(false)
    tracker.markInProgress('github-issue:2', 'team-c')
    expect(tracker.isExhausted('github-issue:2', 3)).toBe(true)
  })

  it('sweepStale preserves the attempt count — a TTL sweep must NOT reset the cap', () => {
    const now = Date.parse('2026-07-30T12:00:00.000Z')
    tracker.markInProgress('github-issue:3', 'team-a', now - 40 * 60_000)
    tracker.markInProgress('github-issue:3', 'team-b', now - 40 * 60_000)

    expect(tracker.sweepStale(30 * 60_000, now)).toBe(1)

    expect(tracker.isActive('github-issue:3')).toBe(false) // re-enqueueable
    expect(tracker.attempts('github-issue:3')).toBe(2) // but the cap still remembers
  })

  it('an exhausted signal stays exhausted across a restart', () => {
    tracker.markInProgress('github-issue:4', 'team-a')
    tracker.markInProgress('github-issue:4', 'team-b')
    const reopened = createSelfIssueTracker(db)
    expect(reopened.attempts('github-issue:4')).toBe(2)
    expect(reopened.isExhausted('github-issue:4', 2)).toBe(true)
  })

  it('markDone resets the counter — a resolved signal starts clean if it is ever reopened', () => {
    tracker.markInProgress('github-issue:5', 'team-a')
    tracker.markDone('github-issue:5')
    expect(tracker.attempts('github-issue:5')).toBe(0)
  })

  it('clear resets the counter — the manual "try this again" lever', () => {
    tracker.markInProgress('github-issue:6', 'team-a')
    tracker.markInProgress('github-issue:6', 'team-b')
    tracker.clear('github-issue:6')
    expect(tracker.attempts('github-issue:6')).toBe(0)
    expect(tracker.isExhausted('github-issue:6', 2)).toBe(false)
  })

  it('a cap of 0 or less disables the guard entirely', () => {
    tracker.markInProgress('github-issue:7', 'team-a')
    expect(tracker.isExhausted('github-issue:7', 0)).toBe(false)
    expect(tracker.isExhausted('github-issue:7', -1)).toBe(false)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import type { TestDb } from '../../../helpers/db-harness.js'
import {
  decideSelfHeal,
  recordSelfHealRestart,
  consumeLastExitReason,
  isSelfHealDisabled,
  setSelfHealDisabled,
  SELF_HEAL_DISABLED_KEY,
  SELF_HEAL_LAST_RESTART_KEY,
  SELF_HEAL_RESTART_HISTORY_KEY,
  SELF_HEAL_EXIT_REASON_KEY,
  DEFAULT_SELF_HEAL_MIN_FAILURES,
  DEFAULT_SELF_HEAL_COOLDOWN_MS,
} from '../../../../src/broker/services/self-heal.js'

let harness: TestDb
let db: import('better-sqlite3').Database

function readState(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM shared_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

beforeEach(() => {
  harness = createBrokerTestDb()
  db = harness.db
})

afterEach(() => {
  harness.close()
})

describe('decideSelfHeal', () => {
  const NOW = 1_000_000_000_000

  it('does not restart below the consecutive-failure threshold', () => {
    const decision = decideSelfHeal(db, {
      consecutiveFailures: DEFAULT_SELF_HEAL_MIN_FAILURES - 1,
      now: NOW,
    })
    expect(decision.shouldRestart).toBe(false)
    expect(decision.reason).toBe('below-threshold')
  })

  it('restarts at the threshold with a clean history and no prior restart', () => {
    const decision = decideSelfHeal(db, {
      consecutiveFailures: DEFAULT_SELF_HEAL_MIN_FAILURES,
      now: NOW,
    })
    expect(decision.shouldRestart).toBe(true)
    expect(decision.reason).toBe('restart')
  })

  it('does not restart when the kill-switch flag is set', () => {
    setSelfHealDisabled(db, true)
    const decision = decideSelfHeal(db, {
      consecutiveFailures: DEFAULT_SELF_HEAL_MIN_FAILURES + 10,
      now: NOW,
    })
    expect(decision.shouldRestart).toBe(false)
    expect(decision.reason).toBe('disabled')
  })

  it('blocks a restart while inside the persisted cooldown window', () => {
    // Last restart was recent.
    recordSelfHealRestart(db, 'self_heal:memory-rss', NOW - 1000)
    const decision = decideSelfHeal(db, {
      consecutiveFailures: DEFAULT_SELF_HEAL_MIN_FAILURES,
      now: NOW,
    })
    expect(decision.shouldRestart).toBe(false)
    expect(decision.reason).toBe('cooldown')
  })

  it('allows a restart once the cooldown window has elapsed', () => {
    recordSelfHealRestart(db, 'self_heal:memory-rss', NOW - DEFAULT_SELF_HEAL_COOLDOWN_MS - 1)
    const decision = decideSelfHeal(db, {
      consecutiveFailures: DEFAULT_SELF_HEAL_MIN_FAILURES,
      now: NOW,
      // Disable escalation interference: 1 prior restart, max 3.
    })
    expect(decision.shouldRestart).toBe(true)
    expect(decision.reason).toBe('restart')
  })

  it('trips the kill-switch after too many restarts in the escalation window', () => {
    // Seed 3 restarts inside a 1h window (older than cooldown so cooldown passes).
    const history = [NOW - 50 * 60_000, NOW - 40 * 60_000, NOW - 30 * 60_000]
    db.prepare(
      `INSERT INTO shared_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run(SELF_HEAL_RESTART_HISTORY_KEY, JSON.stringify(history))
    db.prepare(
      `INSERT INTO shared_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run(SELF_HEAL_LAST_RESTART_KEY, String(NOW - 30 * 60_000))

    const decision = decideSelfHeal(db, {
      consecutiveFailures: DEFAULT_SELF_HEAL_MIN_FAILURES,
      now: NOW,
    })
    expect(decision.shouldRestart).toBe(false)
    expect(decision.reason).toBe('escalation-tripped')
    // Escalation should have persisted the disable flag.
    expect(isSelfHealDisabled(db)).toBe(true)
  })

  it('ignores restarts that fall outside the escalation window', () => {
    // 3 restarts but all older than the 1h window — should not escalate.
    const history = [NOW - 120 * 60_000, NOW - 90 * 60_000, NOW - 70 * 60_000]
    db.prepare(
      `INSERT INTO shared_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run(SELF_HEAL_RESTART_HISTORY_KEY, JSON.stringify(history))
    const decision = decideSelfHeal(db, {
      consecutiveFailures: DEFAULT_SELF_HEAL_MIN_FAILURES,
      now: NOW,
    })
    expect(decision.shouldRestart).toBe(true)
    expect(decision.reason).toBe('restart')
  })

  it('honors a custom minFailures override', () => {
    const decision = decideSelfHeal(db, {
      consecutiveFailures: 2,
      minFailures: 2,
      now: NOW,
    })
    expect(decision.shouldRestart).toBe(true)
  })
})

describe('recordSelfHealRestart', () => {
  const NOW = 2_000_000_000_000

  it('persists last-restart timestamp, appends history, and writes exit reason', () => {
    recordSelfHealRestart(db, 'self_heal:memory-rss', NOW)

    expect(readState(SELF_HEAL_LAST_RESTART_KEY)).toBe(String(NOW))
    expect(readState(SELF_HEAL_EXIT_REASON_KEY)).toBe('self_heal:memory-rss')
    const history = JSON.parse(readState(SELF_HEAL_RESTART_HISTORY_KEY) ?? '[]') as number[]
    expect(history).toEqual([NOW])
  })

  it('appends to existing history within the window and prunes stale entries', () => {
    recordSelfHealRestart(db, 'self_heal:memory-rss', NOW - 120 * 60_000) // stale, outside 1h
    recordSelfHealRestart(db, 'self_heal:memory-rss', NOW - 10 * 60_000) // fresh
    recordSelfHealRestart(db, 'self_heal:memory-rss', NOW) // fresh

    const history = JSON.parse(readState(SELF_HEAL_RESTART_HISTORY_KEY) ?? '[]') as number[]
    // Stale entry pruned; two fresh entries remain.
    expect(history).toEqual([NOW - 10 * 60_000, NOW])
  })
})

describe('consumeLastExitReason', () => {
  it('returns and clears the exit reason (one-shot)', () => {
    db.prepare(
      `INSERT INTO shared_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run(SELF_HEAL_EXIT_REASON_KEY, 'self_heal:memory-rss')

    expect(consumeLastExitReason(db)).toBe('self_heal:memory-rss')
    // Second read returns null — key was deleted.
    expect(consumeLastExitReason(db)).toBeNull()
  })

  it('returns null when no exit reason is set', () => {
    expect(consumeLastExitReason(db)).toBeNull()
  })
})

describe('kill-switch helpers', () => {
  it('setSelfHealDisabled toggles the flag and isSelfHealDisabled reflects it', () => {
    expect(isSelfHealDisabled(db)).toBe(false)
    setSelfHealDisabled(db, true)
    expect(readState(SELF_HEAL_DISABLED_KEY)).toBe('1')
    expect(isSelfHealDisabled(db)).toBe(true)
    setSelfHealDisabled(db, false)
    expect(readState(SELF_HEAL_DISABLED_KEY)).toBeUndefined()
    expect(isSelfHealDisabled(db)).toBe(false)
  })
})

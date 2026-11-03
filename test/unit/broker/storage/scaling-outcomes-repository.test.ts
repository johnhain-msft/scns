import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase } from '../../../../src/broker/storage/db.js'
import {
  recordScalingOutcome,
  findOutcomesBySignature,
  recordScalingDecision,
  findRecentScalingDecisions,
} from '../../../../src/broker/storage/repositories/scaling-outcomes-repository.js'

describe('scaling-outcomes-repository', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => {
    try {
      db.close()
    } catch { /* already closed */ }
  })

  it('records an outcome and finds it by signature', () => {
    const row = recordScalingOutcome(db, {
      task_signature: 'sig:abc',
      spawned_as: 'solo',
      success: true,
      duration_ms: 123,
      quality_score: 0.9,
      source_suggestion_id: 'sugg-1',
      team_id: null,
    })
    expect(row).not.toBeNull()
    expect(row?.success).toBe(1)
    expect(row?.spawned_as).toBe('solo')

    const found = findOutcomesBySignature(db, 'sig:abc')
    expect(found.length).toBe(1)
    expect(found[0].quality_score).toBeCloseTo(0.9)
  })

  it('is idempotent on (source_suggestion_id, spawned_as)', () => {
    recordScalingOutcome(db, {
      task_signature: 'sig:dup',
      spawned_as: 'team',
      success: true,
      source_suggestion_id: 'sugg-dup',
    })
    const second = recordScalingOutcome(db, {
      task_signature: 'sig:dup',
      spawned_as: 'team',
      success: false,
      source_suggestion_id: 'sugg-dup',
    })
    // Returns the existing row, not a new one
    expect(second).not.toBeNull()
    const rows = findOutcomesBySignature(db, 'sig:dup')
    expect(rows.length).toBe(1)
    // Original success value preserved
    expect(rows[0].success).toBe(1)
  })

  it('allows multiple rows when source_suggestion_id is null', () => {
    recordScalingOutcome(db, { task_signature: 'sig:n', spawned_as: 'solo', success: true })
    recordScalingOutcome(db, { task_signature: 'sig:n', spawned_as: 'solo', success: true })
    const rows = findOutcomesBySignature(db, 'sig:n')
    expect(rows.length).toBe(2)
  })

  it('records a decision and surfaces it in recent list with outcome join', () => {
    recordScalingDecision(db, {
      task_signature: 'sig:xyz',
      task_snippet: 'add caching layer',
      hint_shape: 'team',
      chosen_shape: 'solo',
      roles: [],
      reasoning: 'override team→solo: 3/3 solo successes',
      history_count: 4,
      source_suggestion_id: 'sugg-xyz',
    })
    recordScalingOutcome(db, {
      task_signature: 'sig:xyz',
      spawned_as: 'solo',
      success: true,
      quality_score: 0.95,
      source_suggestion_id: 'sugg-xyz',
    })

    const recent = findRecentScalingDecisions(db, 10)
    expect(recent.length).toBe(1)
    expect(recent[0].chosen_shape).toBe('solo')
    expect(recent[0].hint_shape).toBe('team')
    expect(recent[0].reasoning).toMatch(/override/i)
    expect(recent[0].outcome_success).toBe(1)
    expect(recent[0].outcome_quality).toBeCloseTo(0.95)
  })

  it('returns decisions newest-first and respects the limit', () => {
    for (let i = 0; i < 5; i++) {
      recordScalingDecision(db, {
        task_signature: `sig:${i}`,
        task_snippet: `task ${i}`,
        hint_shape: 'solo',
        chosen_shape: 'solo',
        roles: [],
        reasoning: 'defer',
        history_count: 0,
      })
    }
    const recent = findRecentScalingDecisions(db, 3)
    expect(recent.length).toBe(3)
    // The last one inserted should surface first
    expect(recent[0].task_snippet).toBe('task 4')
  })
})

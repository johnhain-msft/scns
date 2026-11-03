/**
 * Integration test: Quality Gate + Session Handoff flow.
 * Tests the full quality fail → handoff → spawn cycle using real DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBrokerTestDb } from '../helpers/broker-db-harness.js'
import type { TestDb } from '../helpers/db-harness.js'
import { createQualityChecker } from '../../src/broker/services/quality-checker.js'
import { createSessionHandoffService } from '../../src/broker/services/session-handoff.js'
import {
  findQualityChecksBySession,
  findLatestHandoff,
  countUncheckedCompletedSessions,
  findUncheckedCompletedSessions,
} from '../../src/broker/storage/repositories/quality-repository.js'
import { createDecisionTree } from '../../src/brain/decision-tree.js'
import { BrainAction, type BrainState } from '../../src/brain/state-types.js'

let testDb: TestDb

beforeEach(() => {
  testDb = createBrokerTestDb()
})

afterEach(() => {
  testDb.close()
})

function makeBaseState(overrides: Partial<BrainState> = {}): BrainState {
  return {
    autonomyLevel: 2,
    userActive: false,
    yieldToUser: true,
    pendingTasks: [],
    activeSessions: 0,
    maxConcurrentSessions: 3,
    contextUsagePercent: 10,
    contextRotationThreshold: 85,
    recentObservationCount: 5,
    lastConsolidationAge: 1,
    consolidationThreshold: 24,
    approvedSuggestionCount: 0,
    pendingQualityChecks: 0,
    otelMetrics: undefined,
    patterns: null,
    ...overrides,
  }
}

describe('Quality Gate + Session Handoff Integration', () => {
  it('quality check pass → no handoff needed', () => {
    const checker = createQualityChecker(testDb.db)
    const result = checker.check({
      sessionId: 'int-sess-1',
      output: 'All 50 tests pass. Build clean. Lint clean.',
      taskType: 'implementation',
    })

    expect(result.passed).toBe(true)

    // No handoff should be needed
    const handoff = findLatestHandoff(testDb.db, 'int-sess-1')
    expect(handoff).toBeNull()
  })

  it('quality check fail → handoff created → handoff consumable', () => {
    // Register session
    testDb.db
      .prepare(
        "INSERT INTO sessions (id, purpose, working_dir, status) VALUES ('fail-sess', 'test', '/tmp', 'completed')",
      )
      .run()

    // Quality check fails
    const checker = createQualityChecker(testDb.db)
    const result = checker.check({
      sessionId: 'fail-sess',
      output: '5 tests fail. Build failed with 2 errors. TypeError in auth.ts.',
      taskType: 'implementation',
    })
    expect(result.passed).toBe(false)
    expect(result.findings.length).toBeGreaterThanOrEqual(2)

    // Create handoff for the failed session
    const handoffSvc = createSessionHandoffService(testDb.db)
    const handoff = handoffSvc.create({
      sessionId: 'fail-sess',
      progress: 'Auth module 60% complete',
      filesModified: ['src/auth.ts', 'src/login.ts'],
      testsStatus: '45/50 pass',
      remainingWork: 'Fix 5 failing tests, resolve TypeError',
      context: `Quality check failed. Findings: ${result.findings.join('; ')}`,
    })

    expect(handoff.id).toBeDefined()
    expect(handoff.status).toBe('ready')

    // Next session retrieves the handoff
    const retrieved = handoffSvc.get('fail-sess')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.progress).toBe('Auth module 60% complete')
    expect(retrieved!.remaining_work).toBe('Fix 5 failing tests, resolve TypeError')

    // Next session consumes the handoff
    const consumed = handoffSvc.consume(handoff.id, 'new-sess-1')
    expect(consumed).toBe(true)

    // Handoff no longer available
    const gone = handoffSvc.get('fail-sess')
    expect(gone).toBeNull()
  })

  it('quality checks are persisted and queryable by session', () => {
    const checker = createQualityChecker(testDb.db)
    checker.check({ sessionId: 'q-sess', output: 'All pass.', taskType: 'implementation' })
    checker.check({ sessionId: 'q-sess', output: '2 tests fail.', taskType: 'implementation' })
    checker.check({ sessionId: 'other', output: 'Clean.', taskType: 'implementation' })

    const checks = findQualityChecksBySession(testDb.db, 'q-sess')
    expect(checks).toHaveLength(2)
  })

  it('countUncheckedCompletedSessions returns correct count', () => {
    // Create completed sessions
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir, status) VALUES (?, 'test', '/tmp', 'completed')")
      .run('done-1')
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir, status) VALUES (?, 'test', '/tmp', 'completed')")
      .run('done-2')
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir, status) VALUES (?, 'test', '/tmp', 'active')")
      .run('active-1')

    expect(countUncheckedCompletedSessions(testDb.db)).toBe(2)

    // Quality check one session
    const checker = createQualityChecker(testDb.db)
    checker.check({ sessionId: 'done-1', output: 'All pass.', taskType: 'implementation' })

    expect(countUncheckedCompletedSessions(testDb.db)).toBe(1)
  })

  it('findUncheckedCompletedSessions returns session IDs', () => {
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir, status) VALUES (?, 'test', '/tmp', 'completed')")
      .run('uc-1')
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir, status) VALUES (?, 'test', '/tmp', 'completed')")
      .run('uc-2')

    const sessions = findUncheckedCompletedSessions(testDb.db)
    expect(sessions).toHaveLength(2)
    expect(sessions).toContain('uc-1')
    expect(sessions).toContain('uc-2')
  })

  describe('Brain decision tree integration', () => {
    it('decides QualityCheck when L2+ and unchecked sessions exist', () => {
      const tree = createDecisionTree()
      const state = makeBaseState({
        autonomyLevel: 2,
        pendingQualityChecks: 2,
      })

      const decision = tree.decide(state)
      expect(decision.action).toBe(BrainAction.QualityCheck)
      expect(decision.reason).toContain('2')
    })

    it('does NOT decide QualityCheck at L1', () => {
      const tree = createDecisionTree()
      const state = makeBaseState({
        autonomyLevel: 1,
        pendingQualityChecks: 3,
      })

      const decision = tree.decide(state)
      expect(decision.action).not.toBe(BrainAction.QualityCheck)
    })

    it('does NOT decide QualityCheck when no unchecked sessions', () => {
      const tree = createDecisionTree()
      const state = makeBaseState({
        autonomyLevel: 3,
        pendingQualityChecks: 0,
      })

      const decision = tree.decide(state)
      expect(decision.action).not.toBe(BrainAction.QualityCheck)
    })

    it('shouldRunQualityCheck returns true at L2+ with pending checks', () => {
      const tree = createDecisionTree()
      expect(
        tree.shouldRunQualityCheck(makeBaseState({ autonomyLevel: 2, pendingQualityChecks: 1 })),
      ).toBe(true)
      expect(
        tree.shouldRunQualityCheck(makeBaseState({ autonomyLevel: 3, pendingQualityChecks: 5 })),
      ).toBe(true)
    })

    it('shouldRunQualityCheck returns false at L0/L1 or no pending', () => {
      const tree = createDecisionTree()
      expect(
        tree.shouldRunQualityCheck(makeBaseState({ autonomyLevel: 0, pendingQualityChecks: 1 })),
      ).toBe(false)
      expect(
        tree.shouldRunQualityCheck(makeBaseState({ autonomyLevel: 1, pendingQualityChecks: 1 })),
      ).toBe(false)
      expect(
        tree.shouldRunQualityCheck(makeBaseState({ autonomyLevel: 2, pendingQualityChecks: 0 })),
      ).toBe(false)
    })

    it('quality check priority is lower than yield-to-user and context rotation', () => {
      const tree = createDecisionTree()

      // User active → yield, not quality check
      const yieldState = makeBaseState({
        autonomyLevel: 2,
        userActive: true,
        pendingQualityChecks: 5,
      })
      expect(tree.decide(yieldState).action).toBe(BrainAction.YieldToUser)

      // High context usage → rotate, not quality check
      const rotateState = makeBaseState({
        autonomyLevel: 2,
        contextUsagePercent: 90,
        pendingQualityChecks: 5,
      })
      expect(tree.decide(rotateState).action).toBe(BrainAction.RotateContext)
    })
  })
})

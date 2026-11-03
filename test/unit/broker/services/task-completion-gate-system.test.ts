/**
 * WS R — gate-driven task completion (system path).
 *
 * When the quality gate emits `quality_gate_verdict.passed=true` on a
 * WS-P-attributed task, the broker itself transitions the task to
 * `status='completed'` — no QA-PASS message required.
 *
 * Two layers under test:
 *
 *   1. `completeTaskBySystem` — the extension to task-completion-gate
 *      that runs the same WS-G/WS-M validators a human PATCH runs,
 *      with a status-guarded UPDATE that mirrors chamber-copilot's
 *      `_onVerifyResult` (lib/job-store.mjs:2836-2858).
 *
 *   2. `handleQualityGateVerdictForTaskCompletion` — the testable
 *      subscriber wired to the `quality_gate_verdict` event in
 *      startup.ts. Resolves the task from team_id, calls
 *      completeTaskBySystem, and emits `task_completed` on success.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  completeTaskBySystem,
  handleQualityGateVerdictForTaskCompletion,
  type SystemCompletionEventLog,
} from '../../../../src/broker/services/task-completion-gate.js'
import { createSession } from '../../../../src/broker/storage/repositories/session-repository.js'

const TEAM_ID = 'team-r1'

interface SeedOptions {
  readonly status?: string
  readonly readbackAt?: string | null
  readonly dispatchId?: string | null
  readonly devSessionId?: string | null
  readonly owner?: string | null
}

function seedTask(testDb: TestDb, opts: SeedOptions = {}): number {
  const status = opts.status ?? 'in_progress'
  const r = testDb.db
    .prepare(
      `INSERT INTO tasks
         (team_id, seq, subject, status, owner,
          dispatch_id, dispatch_readback_at,
          dispatch_manager_session_id, dispatch_dev_session_id, dispatch_qa_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      TEAM_ID,
      1,
      'WS-R fixture',
      status,
      opts.owner === undefined ? 'dev-A' : opts.owner,
      opts.dispatchId === undefined ? 'disp-A' : opts.dispatchId,
      opts.readbackAt === undefined ? '2026-05-12T20:00:00.000Z' : opts.readbackAt,
      'mgr-A',
      opts.devSessionId === undefined ? 'dev-A' : opts.devSessionId,
      'qa-A',
    )
  return Number(r.lastInsertRowid)
}

function seedTeam(testDb: TestDb): void {
  testDb.db
    .prepare(
      "INSERT INTO teams (id, name, description) VALUES (?, ?, 'WS-R fixture')",
    )
    .run(TEAM_ID, TEAM_ID)
}

function seedOwner(testDb: TestDb, sessionId = 'dev-A'): void {
  createSession(testDb.db, {
    id: sessionId,
    purpose: 'ws-r owner',
    working_dir: '/tmp/ws-r-fixture',
    worktree: null,
  })
}

describe('completeTaskBySystem (WS R)', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
    seedTeam(testDb)
  })

  afterEach(() => testDb.close())

  it('case (a): in_progress + WS-P-stamped + staged diff → transitions to completed', () => {
    const taskId = seedTask(testDb)
    seedOwner(testDb)

    const result = completeTaskBySystem(testDb.db, {
      taskId,
      qualityCheckId: 'qc-pass-1',
      gitDiffChecker: () => true,
    })

    expect(result.transitioned).toBe(true)
    const row = testDb.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      status: string
      quality_check_id: string | null
      completed_at: string | null
    }
    expect(row.status).toBe('completed')
    expect(row.quality_check_id).toBe('qc-pass-1')
    expect(row.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('case (b): status=failed → no transition (status guard)', () => {
    const taskId = seedTask(testDb, { status: 'failed' })
    seedOwner(testDb)

    const result = completeTaskBySystem(testDb.db, {
      taskId,
      qualityCheckId: 'qc-pass-1',
      gitDiffChecker: () => true,
    })

    expect(result.transitioned).toBe(false)
    expect(result.reason).toMatch(/status/i)
    const row = testDb.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as {
      status: string
    }
    expect(row.status).toBe('failed')
  })

  it('case (c): dispatch_readback_at IS NULL (legacy) → no transition', () => {
    const taskId = seedTask(testDb, { readbackAt: null })
    seedOwner(testDb)

    const result = completeTaskBySystem(testDb.db, {
      taskId,
      qualityCheckId: 'qc-pass-1',
      gitDiffChecker: () => true,
    })

    expect(result.transitioned).toBe(false)
    expect(result.reason).toMatch(/legacy|readback/i)
  })

  it('case (d): dispatch_id IS NULL → no transition', () => {
    const taskId = seedTask(testDb, { dispatchId: null })
    seedOwner(testDb)

    const result = completeTaskBySystem(testDb.db, {
      taskId,
      qualityCheckId: 'qc-pass-1',
      gitDiffChecker: () => true,
    })

    expect(result.transitioned).toBe(false)
    expect(result.reason).toMatch(/dispatch/i)
  })

  it('case (e): dispatch_dev_session_id is "409:owner" spawn-failure token → no transition', () => {
    const taskId = seedTask(testDb, { devSessionId: '409:dev-other' })
    seedOwner(testDb)

    const result = completeTaskBySystem(testDb.db, {
      taskId,
      qualityCheckId: 'qc-pass-1',
      gitDiffChecker: () => true,
    })

    expect(result.transitioned).toBe(false)
    expect(result.reason).toMatch(/spawn|dev_session/i)
  })

  it('case (f): dispatch_dev_session_id is "spawn-failed:..." token → no transition', () => {
    const taskId = seedTask(testDb, { devSessionId: 'spawn-failed:scns-dev' })
    seedOwner(testDb)

    const result = completeTaskBySystem(testDb.db, {
      taskId,
      qualityCheckId: 'qc-pass-1',
      gitDiffChecker: () => true,
    })

    expect(result.transitioned).toBe(false)
    expect(result.reason).toMatch(/spawn|dev_session/i)
  })

  it('case (g): no staged diff → no transition (gate fails)', () => {
    const taskId = seedTask(testDb)
    seedOwner(testDb)

    const result = completeTaskBySystem(testDb.db, {
      taskId,
      qualityCheckId: 'qc-pass-1',
      gitDiffChecker: () => false,
    })

    expect(result.transitioned).toBe(false)
    expect(result.reason).toMatch(/gate|diff/i)
  })

  it('case (h): system path REQUIRES staged diff (handoff alone is not enough)', () => {
    // WS-R risk: a stale handoff from an earlier dispatch could otherwise
    // mask the absence of a fresh staged diff. completeTaskBySystem must
    // NOT accept the handoff path that the human PATCH route allows.
    const taskId = seedTask(testDb)
    seedOwner(testDb)
    // Insert handoff + passing quality check directly via SQL to avoid
    // dragging in repository helpers — schema is what matters here.
    testDb.db
      .prepare(
        `INSERT INTO session_handoffs (id, session_id, progress)
         VALUES (?, ?, 'stale handoff')`,
      )
      .run('handoff-1', 'dev-A')
    testDb.db
      .prepare(
        `INSERT INTO quality_checks (id, session_id, output, passed, score)
         VALUES (?, ?, '', 1, 100)`,
      )
      .run('qc-stale-1', 'dev-A')

    const result = completeTaskBySystem(testDb.db, {
      taskId,
      qualityCheckId: 'qc-pass-1',
      gitDiffChecker: () => false, // no fresh diff
    })

    expect(result.transitioned).toBe(false)
    expect(result.reason).toMatch(/diff|gate/i)
  })

  it('case (i): idempotent — second call is a no-op (status guard)', () => {
    const taskId = seedTask(testDb)
    seedOwner(testDb)

    const r1 = completeTaskBySystem(testDb.db, {
      taskId,
      qualityCheckId: 'qc-pass-1',
      gitDiffChecker: () => true,
    })
    expect(r1.transitioned).toBe(true)

    const r2 = completeTaskBySystem(testDb.db, {
      taskId,
      qualityCheckId: 'qc-pass-2',
      gitDiffChecker: () => true,
    })
    expect(r2.transitioned).toBe(false)

    const row = testDb.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      status: string
      quality_check_id: string | null
    }
    expect(row.status).toBe('completed')
    // First-write-wins: qc-pass-1 stays.
    expect(row.quality_check_id).toBe('qc-pass-1')
  })
})

describe('handleQualityGateVerdictForTaskCompletion (WS R subscriber)', () => {
  let testDb: TestDb
  let recorded: Array<{ sessionId: string | null; data: Record<string, unknown> }>
  let eventLog: SystemCompletionEventLog

  beforeEach(() => {
    testDb = createBrokerTestDb()
    seedTeam(testDb)
    recorded = []
    eventLog = {
      taskCompleted(sessionId, data) {
        recorded.push({ sessionId, data })
      },
    }
  })

  afterEach(() => testDb.close())

  it('emits task_completed with sessionId=null on PASS verdict for WS-P task', () => {
    const taskId = seedTask(testDb)
    seedOwner(testDb)

    handleQualityGateVerdictForTaskCompletion({
      db: testDb.db,
      eventLog,
      gitDiffChecker: () => true,
      verdict: {
        team_id: TEAM_ID,
        passed: true,
        qualityCheckId: 'qc-pass-7',
      },
    })

    expect(recorded).toHaveLength(1)
    expect(recorded[0].sessionId).toBeNull()
    expect(recorded[0].data.task_id).toBe(taskId)
    expect(recorded[0].data.team_id).toBe(TEAM_ID)
    expect(recorded[0].data.dispatch_id).toBe('disp-A')
    expect(recorded[0].data.quality_check_id).toBe('qc-pass-7')
    expect(recorded[0].data.owner_session_id).toBe('dev-A')
    expect(recorded[0].data.completion_source).toBe('quality_gate_verdict')

    const row = testDb.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as {
      status: string
    }
    expect(row.status).toBe('completed')
  })

  it('no-op when verdict.passed=false', () => {
    seedTask(testDb)
    seedOwner(testDb)

    handleQualityGateVerdictForTaskCompletion({
      db: testDb.db,
      eventLog,
      gitDiffChecker: () => true,
      verdict: { team_id: TEAM_ID, passed: false, qualityCheckId: 'qc-fail-1' },
    })

    expect(recorded).toHaveLength(0)
  })

  it('no-op when qualityCheckId is missing', () => {
    seedTask(testDb)
    seedOwner(testDb)

    handleQualityGateVerdictForTaskCompletion({
      db: testDb.db,
      eventLog,
      gitDiffChecker: () => true,
      verdict: { team_id: TEAM_ID, passed: true },
    })

    expect(recorded).toHaveLength(0)
  })

  it('no-op when team has no in_progress WS-P-stamped task', () => {
    // Seed a task but with dispatch_readback_at NULL (legacy)
    seedTask(testDb, { readbackAt: null })
    seedOwner(testDb)

    handleQualityGateVerdictForTaskCompletion({
      db: testDb.db,
      eventLog,
      gitDiffChecker: () => true,
      verdict: { team_id: TEAM_ID, passed: true, qualityCheckId: 'qc-pass-x' },
    })

    expect(recorded).toHaveLength(0)
  })

  it('skips on ambiguity when team has multiple in_progress WS-P-stamped tasks', () => {
    seedTask(testDb)
    // Insert a second in_progress WS-P-stamped task on the same team —
    // the subscriber must refuse to guess which one the verdict belongs to.
    testDb.db
      .prepare(
        `INSERT INTO tasks
           (team_id, seq, subject, status, owner,
            dispatch_id, dispatch_readback_at,
            dispatch_manager_session_id, dispatch_dev_session_id, dispatch_qa_session_id)
         VALUES (?, 2, 'second WS-P task', 'in_progress', 'dev-B',
                 'disp-B', '2026-05-12T20:01:00.000Z',
                 'mgr-A', 'dev-B', 'qa-B')`,
      )
      .run(TEAM_ID)
    seedOwner(testDb)

    handleQualityGateVerdictForTaskCompletion({
      db: testDb.db,
      eventLog,
      gitDiffChecker: () => true,
      verdict: { team_id: TEAM_ID, passed: true, qualityCheckId: 'qc-amb-1' },
    })

    expect(recorded).toHaveLength(0)
  })
})

// ─── P0.3 — completeTaskByMerge ───────────────────────────────────────────
// Auto-merge-driven completion. Treats the successful merge SHA as
// authoritative evidence (no staged-diff check). Idempotent against the
// verdict subscriber.
describe('completeTaskByMerge (P0.3)', () => {
  let testDb: TestDb
  // Import lazily so the previous suite's import block stays put.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let completeTaskByMerge: any

  beforeEach(async () => {
    testDb = createBrokerTestDb()
    seedTeam(testDb)
    ;({ completeTaskByMerge } = await import(
      '../../../../src/broker/services/task-completion-gate.js'
    ))
  })

  afterEach(() => testDb.close())

  it('stamps merge_sha + completion_source on the in_progress task', () => {
    const taskId = seedTask(testDb)
    const result = completeTaskByMerge(testDb.db, {
      teamId: TEAM_ID,
      mergeSha: 'abc1234merge',
      qualityCheckId: 'qc-merge-1',
    })

    expect(result.transitioned).toBe(true)
    expect(result.reason).toBe('completed')
    expect(result.taskId).toBe(taskId)

    const row = testDb.db
      .prepare(
        'SELECT status, merge_sha, completion_source, quality_check_id, completed_at FROM tasks WHERE id = ?',
      )
      .get(taskId) as {
      status: string
      merge_sha: string
      completion_source: string
      quality_check_id: string
      completed_at: string
    }
    expect(row.status).toBe('completed')
    expect(row.merge_sha).toBe('abc1234merge')
    expect(row.completion_source).toBe('auto_merge')
    expect(row.quality_check_id).toBe('qc-merge-1')
    expect(row.completed_at).toBeTruthy()
  })

  it('does NOT require a staged diff (merge SHA is the evidence)', () => {
    // Deliberately omit owner / working_dir setup — no git checker is invoked.
    seedTask(testDb, { owner: null })
    const result = completeTaskByMerge(testDb.db, {
      teamId: TEAM_ID,
      mergeSha: 'deadbeef',
      qualityCheckId: 'qc-no-diff',
    })
    expect(result.transitioned).toBe(true)
  })

  it('returns no-eligible-task when nothing matches and no completed sibling exists', () => {
    const result = completeTaskByMerge(testDb.db, {
      teamId: TEAM_ID,
      mergeSha: 'xx',
      qualityCheckId: 'qc-none',
    })
    expect(result.transitioned).toBe(false)
    expect(result.reason).toBe('no-eligible-task')
  })

  it('returns already-completed when the verdict subscriber won the race', () => {
    // Simulate: verdict subscriber already completed the task with the
    // same quality_check_id. Auto-merger then fires and looks up by team_id;
    // 0 in_progress matches, but a recently-completed sibling exists.
    const taskId = seedTask(testDb)
    testDb.db
      .prepare(
        `UPDATE tasks
            SET status='completed',
                quality_check_id='qc-shared',
                completed_at = datetime('now')
          WHERE id = ?`,
      )
      .run(taskId)

    const result = completeTaskByMerge(testDb.db, {
      teamId: TEAM_ID,
      mergeSha: 'merge-after-verdict',
      qualityCheckId: 'qc-shared',
    })
    expect(result.transitioned).toBe(false)
    expect(result.reason).toBe('already-completed')
  })

  it('returns ambiguous-multiple-in-progress when 2+ tasks match', () => {
    seedTask(testDb, { dispatchId: 'disp-A' })
    // second in_progress WS-P-stamped task for same team
    testDb.db
      .prepare(
        `INSERT INTO tasks (team_id, seq, subject, status, owner,
                            dispatch_id, dispatch_readback_at,
                            dispatch_manager_session_id, dispatch_dev_session_id, dispatch_qa_session_id)
         VALUES (?, ?, 'second', 'in_progress', 'dev-B', 'disp-B',
                 '2026-05-12T20:01:00.000Z', 'mgr-B', 'dev-B', 'qa-B')`,
      )
      .run(TEAM_ID, 2)

    const result = completeTaskByMerge(testDb.db, {
      teamId: TEAM_ID,
      mergeSha: 'shouldnt-stamp',
      qualityCheckId: 'qc-ambig',
    })
    expect(result.transitioned).toBe(false)
    expect(result.reason).toBe('ambiguous-multiple-in-progress')

    // Neither row should be touched.
    const rows = testDb.db
      .prepare('SELECT status, merge_sha FROM tasks WHERE team_id = ?')
      .all(TEAM_ID) as Array<{ status: string; merge_sha: string | null }>
    expect(rows.every((r) => r.status === 'in_progress')).toBe(true)
    expect(rows.every((r) => r.merge_sha == null)).toBe(true)
  })

  it('is idempotent — second call returns race-status-changed', () => {
    const taskId = seedTask(testDb)
    const first = completeTaskByMerge(testDb.db, {
      teamId: TEAM_ID,
      mergeSha: 'sha-1',
      qualityCheckId: 'qc-idem',
    })
    expect(first.transitioned).toBe(true)

    // The row is now status='completed'; a second call with a DIFFERENT
    // quality_check_id (so the already-completed sibling lookup misses)
    // should hit the in_progress filter and return no-eligible-task.
    const second = completeTaskByMerge(testDb.db, {
      teamId: TEAM_ID,
      mergeSha: 'sha-2',
      qualityCheckId: 'qc-different',
    })
    expect(second.transitioned).toBe(false)
    expect(['no-eligible-task', 'already-completed']).toContain(second.reason)

    // Row should still carry the FIRST merge_sha — no overwrite.
    const row = testDb.db
      .prepare('SELECT merge_sha FROM tasks WHERE id = ?')
      .get(taskId) as { merge_sha: string }
    expect(row.merge_sha).toBe('sha-1')
  })

  it('preserves a verdict-subscriber-set quality_check_id via COALESCE when null passed', () => {
    const taskId = seedTask(testDb)
    // Simulate verdict subscriber having already stamped a quality_check_id
    // but somehow leaving the row in_progress (shouldn't normally happen,
    // but COALESCE behaviour matters for partial-state recovery).
    testDb.db
      .prepare('UPDATE tasks SET quality_check_id = ? WHERE id = ?')
      .run('qc-pre-existing', taskId)

    const result = completeTaskByMerge(testDb.db, {
      teamId: TEAM_ID,
      mergeSha: 'sha-coalesce',
      qualityCheckId: null,
    })
    expect(result.transitioned).toBe(true)

    const row = testDb.db
      .prepare('SELECT quality_check_id FROM tasks WHERE id = ?')
      .get(taskId) as { quality_check_id: string }
    expect(row.quality_check_id).toBe('qc-pre-existing')
  })

  it('refuses to transition rows missing dispatch_id (WS-P attribution)', () => {
    seedTask(testDb, { dispatchId: null })
    const result = completeTaskByMerge(testDb.db, {
      teamId: TEAM_ID,
      mergeSha: 'sha-x',
      qualityCheckId: 'qc-x',
    })
    expect(result.transitioned).toBe(false)
    expect(result.reason).toBe('no-eligible-task')
  })
})

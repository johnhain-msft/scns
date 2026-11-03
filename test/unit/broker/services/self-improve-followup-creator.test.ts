/**
 * Task 26 — Close perpetual-loop gap.
 *
 * Bug: managers run exactly one ACP turn and exit (only scns-dev is
 * nudge-eligible). After dev/QA results land via quality_gate_verdict,
 * nothing creates a follow-up task, so the autospawner has nothing to
 * pick up and the dogfood loop dies after one task.
 *
 * Fix (option b): a new broker service subscribes to
 * `quality_gate_verdict` and, for teams whose name matches the
 * self-improve allowlist, auto-creates a follow-up task on the same
 * team. The team-task-autospawner then spawns a fresh manager against
 * that task on its next tick — closing the loop.
 *
 * Halt rule: after N (default 3) consecutive failed verdicts on the
 * same team, create a single "self-improve loop halted" summary task
 * instead of another postmortem follow-up, and stop creating tasks
 * until a human resets.
 *
 * Idempotency: each verdict carries a qualityCheckId; the service
 * embeds that id in the follow-up's description as `[qc:<id>]` and
 * refuses to create a second follow-up for the same id (defends
 * against a flaky verdict bus that fires twice).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createTeam } from '../../../../src/broker/storage/repositories/team-repository.js'
import { findTasksByTeam } from '../../../../src/broker/storage/repositories/task-repository.js'
import { createSelfImproveFollowupCreator } from '../../../../src/broker/services/self-improve-followup-creator.js'
import {
  createEventDispatcher,
  type TypedEvent,
} from '../../../../src/broker/event-dispatcher.js'

function makeVerdictEvent(
  payload: { team_id?: string | null; passed?: boolean; qualityCheckId?: string | null },
): TypedEvent {
  return {
    id: 1,
    event_type: 'quality_gate_verdict',
    session_id: null,
    payload: JSON.stringify(payload),
    team_id: payload.team_id ?? null,
    created_at: new Date().toISOString(),
  }
}

describe('selfImproveFollowupCreator', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => {
    closeDatabase(db)
  })

  it('creates a postmortem follow-up task on a passing verdict for an eligible team', () => {
    createTeam(db, { id: 'team-si-1', name: 'scns-self-improve-v2' })
    const svc = createSelfImproveFollowupCreator({ db, dispatcher: createEventDispatcher() })

    const result = svc.handleVerdict({
      team_id: 'team-si-1',
      passed: true,
      qualityCheckId: 'qc-1',
    })

    expect(result.action).toBe('created')
    const tasks = findTasksByTeam(db, 'team-si-1')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.status).toBe('pending')
    expect(tasks[0]?.subject.toLowerCase()).toContain('postmortem')
    expect(tasks[0]?.description ?? '').toContain('[qc:qc-1]')
  })

  it('creates a follow-up on a failing verdict (failure count 1 of 3)', () => {
    createTeam(db, { id: 'team-si-2', name: 'scns-self-improve-v2' })
    const svc = createSelfImproveFollowupCreator({ db, dispatcher: createEventDispatcher() })

    const result = svc.handleVerdict({
      team_id: 'team-si-2',
      passed: false,
      qualityCheckId: 'qc-fail-1',
    })

    expect(result.action).toBe('created')
    expect(findTasksByTeam(db, 'team-si-2')).toHaveLength(1)
  })

  it('halts after 3 consecutive failed verdicts and emits a single halt task', () => {
    createTeam(db, { id: 'team-si-3', name: 'scns-self-improve-v2' })
    const svc = createSelfImproveFollowupCreator({ db, dispatcher: createEventDispatcher() })

    const r1 = svc.handleVerdict({ team_id: 'team-si-3', passed: false, qualityCheckId: 'a' })
    const r2 = svc.handleVerdict({ team_id: 'team-si-3', passed: false, qualityCheckId: 'b' })
    const r3 = svc.handleVerdict({ team_id: 'team-si-3', passed: false, qualityCheckId: 'c' })
    const r4 = svc.handleVerdict({ team_id: 'team-si-3', passed: false, qualityCheckId: 'd' })

    expect(r1.action).toBe('created')
    expect(r2.action).toBe('created')
    expect(r3.action).toBe('halted')
    expect(r4.action).toBe('skipped')
    expect(r4.reason).toBe('already-halted')

    const tasks = findTasksByTeam(db, 'team-si-3')
    expect(tasks).toHaveLength(3)
    const haltTask = tasks.find((t) => t.subject.toLowerCase().includes('halted'))
    expect(haltTask).toBeDefined()
  })

  it('resets the failure counter when a passing verdict lands in the middle of failures', () => {
    createTeam(db, { id: 'team-si-4', name: 'scns-self-improve-v2' })
    const svc = createSelfImproveFollowupCreator({ db, dispatcher: createEventDispatcher() })

    svc.handleVerdict({ team_id: 'team-si-4', passed: false, qualityCheckId: 'f1' })
    svc.handleVerdict({ team_id: 'team-si-4', passed: false, qualityCheckId: 'f2' })
    svc.handleVerdict({ team_id: 'team-si-4', passed: true, qualityCheckId: 'p1' })
    const r = svc.handleVerdict({ team_id: 'team-si-4', passed: false, qualityCheckId: 'f3' })

    expect(r.action).toBe('created')
    const tasks = findTasksByTeam(db, 'team-si-4')
    expect(tasks).toHaveLength(4)
    expect(tasks.every((t) => !t.subject.toLowerCase().includes('halted'))).toBe(true)
  })

  it('skips teams whose name does not match the self-improve allowlist', () => {
    createTeam(db, { id: 'team-other', name: 'regular-feature-team' })
    const svc = createSelfImproveFollowupCreator({ db, dispatcher: createEventDispatcher() })

    const r = svc.handleVerdict({
      team_id: 'team-other',
      passed: true,
      qualityCheckId: 'qc-x',
    })

    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('team-not-eligible')
    expect(findTasksByTeam(db, 'team-other')).toHaveLength(0)
  })

  it('honours custom team prefixes when supplied', () => {
    createTeam(db, { id: 'team-custom', name: 'meta-team-42' })
    const svc = createSelfImproveFollowupCreator({
      db,
      dispatcher: createEventDispatcher(),
      options: { teamPrefixes: ['meta-team'] },
    })

    const r = svc.handleVerdict({
      team_id: 'team-custom',
      passed: true,
      qualityCheckId: 'qc-meta',
    })
    expect(r.action).toBe('created')
  })

  it('skips when payload is missing required fields', () => {
    createTeam(db, { id: 'team-si-5', name: 'scns-self-improve-v2' })
    const svc = createSelfImproveFollowupCreator({ db, dispatcher: createEventDispatcher() })

    expect(svc.handleVerdict({ team_id: null, passed: true, qualityCheckId: 'q' }).action).toBe(
      'skipped',
    )
    expect(
      svc.handleVerdict({ team_id: 'team-si-5', qualityCheckId: 'q' }).action,
    ).toBe('skipped')
    expect(svc.handleVerdict({ team_id: 'team-si-5', passed: true }).action).toBe('skipped')
  })

  it('skips when the team does not exist', () => {
    const svc = createSelfImproveFollowupCreator({ db, dispatcher: createEventDispatcher() })
    const r = svc.handleVerdict({
      team_id: 'team-missing',
      passed: true,
      qualityCheckId: 'qc-m',
    })
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('team-not-found')
  })

  it('is idempotent — refuses to create a second follow-up for the same qualityCheckId', () => {
    createTeam(db, { id: 'team-si-6', name: 'scns-self-improve-v2' })
    const svc = createSelfImproveFollowupCreator({ db, dispatcher: createEventDispatcher() })

    const r1 = svc.handleVerdict({
      team_id: 'team-si-6',
      passed: true,
      qualityCheckId: 'qc-dup',
    })
    const r2 = svc.handleVerdict({
      team_id: 'team-si-6',
      passed: true,
      qualityCheckId: 'qc-dup',
    })

    expect(r1.action).toBe('created')
    expect(r2.action).toBe('skipped')
    expect(r2.reason).toBe('already-followed-up')
    expect(findTasksByTeam(db, 'team-si-6')).toHaveLength(1)
  })

  it('wires the dispatcher subscription on start() and unsubscribes on stop()', () => {
    createTeam(db, { id: 'team-si-7', name: 'scns-self-improve-v2' })
    const dispatcher = createEventDispatcher()
    const svc = createSelfImproveFollowupCreator({ db, dispatcher })

    svc.start()
    dispatcher.dispatch(
      makeVerdictEvent({ team_id: 'team-si-7', passed: true, qualityCheckId: 'sub-1' }),
    )
    expect(findTasksByTeam(db, 'team-si-7')).toHaveLength(1)

    svc.stop()
    dispatcher.dispatch(
      makeVerdictEvent({ team_id: 'team-si-7', passed: true, qualityCheckId: 'sub-2' }),
    )
    // No new task after stop().
    expect(findTasksByTeam(db, 'team-si-7')).toHaveLength(1)
  })

  it('never throws on malformed payloads (swallows JSON errors)', () => {
    const dispatcher = createEventDispatcher()
    const svc = createSelfImproveFollowupCreator({ db, dispatcher })
    svc.start()
    expect(() =>
      dispatcher.dispatch({
        id: 99,
        event_type: 'quality_gate_verdict',
        session_id: null,
        payload: '{not-json',
        team_id: null,
        created_at: new Date().toISOString(),
      }),
    ).not.toThrow()
    svc.stop()
  })
})

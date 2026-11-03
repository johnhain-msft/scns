import { describe, it, expect } from 'vitest'
import {
  planAutoDispatch,
  synthesizeReadbackBody,
  buildDispatchStartedPayload,
  type AutoDispatchOutcome,
} from '../../../../src/broker/services/auto-dispatch.js'
import { parseManagerReadback } from '../../../../src/broker/services/manager-dispatch-readback.js'

const baseInput = {
  task: {
    id: 12,
    subject: 'Fix the parser',
    description: 'Make the parser stop swallowing errors.',
  },
  managerSession: { sessionId: 'mgr-1' },
  team: { id: 'team-abc', name: 'team-abc' },
  workingDir: '/tmp/repo',
}

describe('planAutoDispatch', () => {
  it('returns one scns-dev and one scns-qa SpawnRequest bound to manager team', () => {
    const plan = planAutoDispatch(baseInput)

    expect(plan.dev.role).toBe('scns-dev')
    expect(plan.qa.role).toBe('scns-qa')
    expect(plan.dev.team_id).toBe('team-abc')
    expect(plan.qa.team_id).toBe('team-abc')
  })

  it('carries the task id in extra_context for both requests', () => {
    const plan = planAutoDispatch(baseInput)

    expect(plan.dev.extra_context).toContain('12')
    expect(plan.qa.extra_context).toContain('12')
    // It should reference the originating manager so downstream gates can
    // attribute the work back to the dispatch.
    expect(plan.dev.extra_context).toContain('mgr-1')
    expect(plan.qa.extra_context).toContain('mgr-1')
  })

  it('produces distinct uuid dispatch_id strings on each request', () => {
    const plan = planAutoDispatch(baseInput)

    expect(plan.dev.dispatch_id).toBeTruthy()
    expect(plan.qa.dispatch_id).toBeTruthy()
    expect(plan.dev.dispatch_id).not.toBe(plan.qa.dispatch_id)
    // uuid v4 shape
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    expect(plan.dev.dispatch_id).toMatch(uuidRe)
    expect(plan.qa.dispatch_id).toMatch(uuidRe)
  })

  it('uses the injected uuid factory when provided (deterministic in tests)', () => {
    let i = 0
    const ids = [
      '11111111-2222-4333-8444-555555555555',
      '66666666-7777-4888-8999-aaaaaaaaaaaa',
    ]
    const plan = planAutoDispatch({ ...baseInput, uuid: () => ids[i++]! })

    expect(plan.dev.dispatch_id).toBe(ids[0])
    expect(plan.qa.dispatch_id).toBe(ids[1])
  })

  it('passes through working_dir on both requests', () => {
    const plan = planAutoDispatch(baseInput)
    expect(plan.dev.working_dir).toBe('/tmp/repo')
    expect(plan.qa.working_dir).toBe('/tmp/repo')
  })

  it('builds a non-empty role-aware prompt for each request', () => {
    const plan = planAutoDispatch(baseInput)
    expect(typeof plan.dev.prompt).toBe('string')
    expect(plan.dev.prompt.length).toBeGreaterThan(50)
    expect(typeof plan.qa.prompt).toBe('string')
    expect(plan.qa.prompt.length).toBeGreaterThan(50)
  })

  it('gives each request a deterministic, distinct name including task id and role', () => {
    const plan = planAutoDispatch(baseInput)
    expect(plan.dev.name).not.toBe(plan.qa.name)
    expect(plan.dev.name).toContain('12')
    expect(plan.qa.name).toContain('12')
    expect(plan.dev.name).toContain('dev')
    expect(plan.qa.name).toContain('qa')
  })
})

describe('synthesizeReadbackBody', () => {
  it('emits a Dispatch Readback block parseable by parseManagerReadback', () => {
    const dev: AutoDispatchOutcome = { kind: 'spawned', sessionId: 'dev-7' }
    const qa: AutoDispatchOutcome = { kind: 'spawned', sessionId: 'qa-9' }
    const body = synthesizeReadbackBody({
      devOutcome: dev,
      qaOutcome: qa,
      notes: 'broker auto-dispatch for task 12',
    })

    const parsed = parseManagerReadback(body)
    expect(parsed.devSessionId).toBe('dev-7')
    expect(parsed.qaSessionId).toBe('qa-9')
    expect(parsed.notes).toContain('auto-dispatch')
  })

  it('records 409:<existingOwner> when dev already has an owner', () => {
    const dev: AutoDispatchOutcome = { kind: 'existing_owner', existingOwner: 'dev-old' }
    const qa: AutoDispatchOutcome = { kind: 'spawned', sessionId: 'qa-9' }
    const body = synthesizeReadbackBody({
      devOutcome: dev,
      qaOutcome: qa,
      notes: 'qa fresh, dev pre-existing',
    })

    expect(body).toContain('409:dev-old')
    // Parser still succeeds because dev_session_id is non-empty.
    const parsed = parseManagerReadback(body)
    expect(parsed.devSessionId).toBe('409:dev-old')
    expect(parsed.qaSessionId).toBe('qa-9')
  })

  it('records 409:<existingOwner> when qa already has an owner', () => {
    const dev: AutoDispatchOutcome = { kind: 'spawned', sessionId: 'dev-7' }
    const qa: AutoDispatchOutcome = { kind: 'existing_owner', existingOwner: 'qa-old' }
    const body = synthesizeReadbackBody({
      devOutcome: dev,
      qaOutcome: qa,
      notes: 'dev fresh, qa pre-existing',
    })

    expect(body).toContain('409:qa-old')
    const parsed = parseManagerReadback(body)
    expect(parsed.qaSessionId).toBe('409:qa-old')
  })
})

// WS M (Phase 13.13.x) — strict dispatch_id attribution. The auto-dispatch
// flow records a `dispatch_started` event whose payload binds each spawned
// dev/qa session_id to the uuid dispatch_id assigned by planAutoDispatch.
// Downstream consumers (dev-productivity-monitor, task-completion-gate) use
// this payload to attribute work strictly to the originating dispatch.
describe('buildDispatchStartedPayload', () => {
  function freshPlan() {
    let i = 0
    const ids = [
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    ]
    return planAutoDispatch({
      task: { id: 99, subject: 'WS M test', description: null },
      managerSession: { sessionId: 'mgr-X' },
      team: { id: 'team-X', name: 'team-X' },
      workingDir: '/tmp/r',
      uuid: () => ids[i++]!,
    })
  }

  it('builds payload binding each session_id to its dispatch_id and includes started_at', () => {
    const plan = freshPlan()
    const startedAt = new Date('2026-05-12T11:00:00Z')
    const payload = buildDispatchStartedPayload({
      plan,
      devOutcome: { kind: 'spawned', sessionId: 'dev-S' },
      qaOutcome: { kind: 'spawned', sessionId: 'qa-S' },
      task: { id: 99 },
      teamId: 'team-X',
      managerSessionId: 'mgr-X',
      startedAt,
    })

    expect(payload.task_id).toBe(99)
    expect(payload.team_id).toBe('team-X')
    expect(payload.manager_session_id).toBe('mgr-X')
    expect(payload.started_at).toBe(startedAt.toISOString())
    expect(payload.dev.session_id).toBe('dev-S')
    expect(payload.dev.dispatch_id).toBe(plan.dev.dispatch_id)
    expect(payload.qa.session_id).toBe('qa-S')
    expect(payload.qa.dispatch_id).toBe(plan.qa.dispatch_id)
  })

  it('records 409:<existing_owner> as session_id for existing-owner outcomes', () => {
    const plan = freshPlan()
    const payload = buildDispatchStartedPayload({
      plan,
      devOutcome: { kind: 'existing_owner', existingOwner: 'dev-old' },
      qaOutcome: { kind: 'spawned', sessionId: 'qa-S' },
      task: { id: 99 },
      teamId: 'team-X',
      managerSessionId: 'mgr-X',
      startedAt: new Date(),
    })

    expect(payload.dev.session_id).toBe('409:dev-old')
    // dispatch_id is still the planned uuid — the dispatch was attempted
    // even though no fresh spawn happened.
    expect(payload.dev.dispatch_id).toBe(plan.dev.dispatch_id)
  })
})

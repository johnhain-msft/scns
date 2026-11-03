/**
 * Idle reaping — the pure planner's half.
 *
 * Covers the decision itself (when `stop-idle` is and is not planned) and the
 * property the whole feature rests on: `stopped` never spawns on its own, so a
 * reaped child stays down until DEMAND wakes it via `/api/meta/resolve`.
 *
 * Context: 16 child brokers were live on one machine, 12 of them for
 * directories with no Copilot session, ~1.47 GB private bytes and ~500s CPU
 * each over 30 hours. Nothing reaped them because no idle concept existed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  applyMetaSchema,
  registerProject,
  updateChildState,
  recordHealthFailure,
} from '../../../src/meta-broker/registry.js'
import {
  planTick,
  DEFAULT_IDLE_TIMEOUT_MS,
  type PlanTickInput,
} from '../../../src/meta-broker/supervisor-tick.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  applyMetaSchema(db)
})

afterEach(() => {
  db.close()
})

const POLICY = {
  minFailures: 3,
  cooldownMs: 30_000,
  maxRestartsPerWindow: 3,
  windowMs: 600_000,
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000

function seedRunning(projectId: string, projectRoot = '/repo/a'): void {
  registerProject(db, { projectId, projectRoot })
  updateChildState(db, projectId, {
    status: 'running',
    boundPort: 3500,
    childPid: 1,
    instanceId: 'i1',
    lastSeenAt: 'now',
  })
}

function plan(overrides: Partial<PlanTickInput> = {}): ReturnType<typeof planTick> {
  return planTick(db, {
    nowMs: 10_000_000,
    policy: POLICY,
    restartHistoryByProject: new Map(),
    lastRestartByProject: new Map(),
    ...overrides,
  })
}

describe('idle reaping — planner', () => {
  it('defaults the idle timeout to 4 hours', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(FOUR_HOURS_MS)
  })

  it('plans stop-idle for a running child past the idle timeout', () => {
    seedRunning('p1')
    const actions = plan({
      idleMsByProject: new Map([['p1', FOUR_HOURS_MS + 1]]),
    }).actions
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ kind: 'stop-idle', projectId: 'p1' })
  })

  it('probes rather than reaps a child still inside the idle window', () => {
    seedRunning('p1')
    const actions = plan({
      idleMsByProject: new Map([['p1', FOUR_HOURS_MS - 1]]),
    }).actions
    expect(actions[0]).toMatchObject({ kind: 'probe', projectId: 'p1' })
  })

  it('NEVER reaps when idleness is unknown (no probe has reported it)', () => {
    // The fail-safe. A child the supervisor cannot reach, one too old to report
    // `last_request_age_seconds`, or one not yet probed, must keep running —
    // silence is not evidence of idleness.
    seedRunning('p1')
    const actions = plan({ idleMsByProject: new Map() }).actions
    expect(actions[0]).toMatchObject({ kind: 'probe', projectId: 'p1' })
    expect(actions.find((a) => a.kind === 'stop-idle')).toBeUndefined()
  })

  it('does not reap a child with recorded health failures — that is the restart policy\u2019s call', () => {
    seedRunning('p1')
    recordHealthFailure(db, 'p1', 'transient blip')
    const actions = plan({
      idleMsByProject: new Map([['p1', FOUR_HOURS_MS * 10]]),
    }).actions
    expect(actions.find((a) => a.kind === 'stop-idle')).toBeUndefined()
  })

  it('does not reap a child that is still starting', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'starting',
      boundPort: 3500,
      childPid: 1,
      instanceId: 'i1',
      lastSeenAt: 'now',
    })
    const actions = plan({
      idleMsByProject: new Map([['p1', FOUR_HOURS_MS * 10]]),
    }).actions
    expect(actions[0]).toMatchObject({ kind: 'probe', projectId: 'p1' })
  })

  it('honours an explicit idleTimeoutMs from the policy', () => {
    seedRunning('p1')
    const actions = plan({
      policy: { ...POLICY, idleTimeoutMs: 60_000 },
      idleMsByProject: new Map([['p1', 61_000]]),
    }).actions
    expect(actions[0]).toMatchObject({ kind: 'stop-idle', projectId: 'p1', idleMs: 61_000 })
  })

  it('disables reaping entirely when idleTimeoutMs is 0', () => {
    seedRunning('p1')
    const actions = plan({
      policy: { ...POLICY, idleTimeoutMs: 0 },
      idleMsByProject: new Map([['p1', FOUR_HOURS_MS * 100]]),
    }).actions
    expect(actions[0]).toMatchObject({ kind: 'probe', projectId: 'p1' })
  })

  it('paces a reap after a recent attempt (refused stops must not retry every tick)', () => {
    seedRunning('p1')
    const base = {
      idleMsByProject: new Map([['p1', FOUR_HOURS_MS * 2]]),
      policy: { ...POLICY, reapCooldownMs: 600_000 },
    }
    const inCooldown = plan({
      ...base,
      nowMs: 10_000_000,
      lastReapAttemptByProject: new Map([['p1', 10_000_000 - 1_000]]),
    }).actions
    expect(inCooldown.find((a) => a.kind === 'stop-idle')).toBeUndefined()

    const afterCooldown = plan({
      ...base,
      nowMs: 10_000_000,
      lastReapAttemptByProject: new Map([['p1', 10_000_000 - 600_001]]),
    }).actions
    expect(afterCooldown[0]).toMatchObject({ kind: 'stop-idle', projectId: 'p1' })
  })
})

describe('idle reaping — demand the child cannot see (last_resolved_at)', () => {
  /**
   * `/api/meta/resolve` runs on the GLOBAL broker and never contacts the
   * child, so a session that resolves and has not yet spoken is invisible to
   * the child's own request clock. Without this signal a session resolving at
   * 3h59m has its broker reaped out from under it seconds later; it recovers,
   * but its first write is refused, and it would recur near every boundary.
   */
  function seedRunningResolvedAt(resolvedAtMs: number | null): void {
    seedRunning('p1')
    if (resolvedAtMs !== null) {
      db.prepare('UPDATE projects SET last_resolved_at = ? WHERE project_id = ?').run(
        new Date(resolvedAtMs).toISOString(),
        'p1',
      )
    }
  }

  it('a recent resolve protects a child the child itself believes is idle', () => {
    const nowMs = 10_000_000
    seedRunningResolvedAt(nowMs - 1_000)
    const actions = plan({
      nowMs,
      idleMsByProject: new Map([['p1', FOUR_HOURS_MS * 2]]),
    }).actions
    expect(actions.find((a) => a.kind === 'stop-idle')).toBeUndefined()
    expect(actions[0]).toMatchObject({ kind: 'probe', projectId: 'p1' })
  })

  it('an OLD resolve does not protect it', () => {
    const nowMs = 10_000_000
    seedRunningResolvedAt(nowMs - FOUR_HOURS_MS * 2)
    const actions = plan({
      nowMs,
      idleMsByProject: new Map([['p1', FOUR_HOURS_MS * 2]]),
    }).actions
    expect(actions[0]).toMatchObject({ kind: 'stop-idle', projectId: 'p1' })
  })

  it('a resolve stamp can only SHORTEN idleness, never establish it', () => {
    // The safe direction. An old `last_resolved_at` is not evidence that
    // nobody is using the broker — a session that resolved once and has been
    // working hard ever since resolves no more. Without the child's own
    // reading, nothing may be reaped.
    const nowMs = 10_000_000
    seedRunningResolvedAt(nowMs - FOUR_HOURS_MS * 10)
    const actions = plan({ nowMs, idleMsByProject: new Map() }).actions
    expect(actions.find((a) => a.kind === 'stop-idle')).toBeUndefined()
    expect(actions[0]).toMatchObject({ kind: 'probe', projectId: 'p1' })
  })

  it('an unparseable stamp is ignored, falling back to the child reading', () => {
    seedRunning('p1')
    db.prepare("UPDATE projects SET last_resolved_at = 'not-a-date' WHERE project_id = 'p1'").run()
    const actions = plan({
      nowMs: 10_000_000,
      idleMsByProject: new Map([['p1', FOUR_HOURS_MS * 2]]),
    }).actions
    expect(actions[0]).toMatchObject({ kind: 'stop-idle', projectId: 'p1' })
  })

  it('ACCEPTANCE: an idle-reaped project does NOT respawn on its own', () => {
    // `registered` spawns on the very next tick and
    // `failed` spawns after the retry backoff, so either would make the reap a
    // no-op. `stopped` stays down — and stays down no matter how much later
    // the tick runs.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'stopped',
      stoppedReason: 'idle',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: new Date(1_000).toISOString(),
    })
    for (const nowMs of [10_000, 1_000_000, 86_400_000, 30 * 86_400_000]) {
      expect(plan({ nowMs }).actions, `no action at nowMs=${nowMs}`).toEqual([])
    }
  })

  it('spawns an idle-reaped project only once a wake has flipped it to registered', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'stopped',
      stoppedReason: 'idle',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: new Date(1_000).toISOString(),
    })
    expect(plan().actions).toEqual([])

    // What `/api/meta/resolve` does on demand (see registry.wakeIdleProject).
    db.prepare(
      "UPDATE projects SET status='registered', stopped_reason=NULL WHERE project_id='p1'",
    ).run()

    expect(plan().actions).toEqual([{ kind: 'spawn', projectId: 'p1', projectRoot: '/repo/a' }])
  })
})

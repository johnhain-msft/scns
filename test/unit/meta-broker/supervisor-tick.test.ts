/**
 * P7 — Supervisor tick logic (pure decisions over registry state).
 *
 * The supervisor's main loop:
 *   1. List registered projects.
 *   2. For each project, evaluate desired state vs observed state.
 *   3. Emit actions for the I/O-doing caller (spawn / probe / restart / suspend).
 *
 * Keeping this pure makes the orchestrator trivially testable. The actual
 * fork/probe/sigterm side-effects live in meta-supervisor.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  applyMetaSchema,
  registerProject,
  updateChildState,
  recordHealthFailure,
} from '../../../src/meta-broker/registry.js'
import { planTick, type TickPlan } from '../../../src/meta-broker/supervisor-tick.js'

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

describe('planTick', () => {
  it('plans a spawn for a freshly registered project', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    const plan = planTick(db, {
      nowMs: 1_000,
      policy: POLICY,
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map(),
    })
    expect(plan.actions).toHaveLength(1)
    expect(plan.actions[0]).toMatchObject({ kind: 'spawn', projectId: 'p1' })
  })

  it('plans a probe for a starting project so it can promote to running', () => {
    // Regression: a freshly-spawned child sits in 'starting' with a bound port +
    // instance id. It MUST be probed (identity check) so a success flips it to
    // 'running'. Previously 'starting' returned no action → the child was never
    // probed and never left 'starting'.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'starting',
      boundPort: 3500,
      childPid: 1,
      instanceId: 'i1',
      lastSeenAt: 'now',
    })
    const plan = planTick(db, {
      nowMs: 1_000,
      policy: POLICY,
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map(),
    })
    expect(plan.actions[0]).toMatchObject({
      kind: 'probe',
      projectId: 'p1',
      boundPort: 3500,
      instanceId: 'i1',
    })
  })

  it('never restarts/suspends a starting project even if early-boot probes failed', () => {
    // While a child is booting, its HTTP server may refuse connections → probe
    // failures accumulate. A booting child must be probed until it answers, never
    // restarted/suspended for not-yet-listening.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'starting',
      boundPort: 3500,
      childPid: 1,
      instanceId: 'i1',
      lastSeenAt: 'now',
    })
    for (let i = 0; i < 5; i++) recordHealthFailure(db, 'p1', 'ECONNREFUSED during boot')
    const plan = planTick(db, {
      nowMs: 1_000_000,
      policy: POLICY,
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map(),
    })
    expect(plan.actions[0]).toMatchObject({ kind: 'probe', projectId: 'p1' })
    expect(plan.actions.find((a) => a.kind === 'restart' || a.kind === 'suspend')).toBeUndefined()
  })

  it('plans a probe for a running project', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'running',
      boundPort: 3500,
      childPid: 1,
      instanceId: 'i1',
      lastSeenAt: 'now',
    })
    const plan = planTick(db, {
      nowMs: 1_000,
      policy: POLICY,
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map(),
    })
    expect(plan.actions[0]).toMatchObject({
      kind: 'probe',
      projectId: 'p1',
      boundPort: 3500,
      instanceId: 'i1',
    })
  })

  it('plans a restart for a failing project that crosses the threshold', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'running',
      boundPort: 3500,
      childPid: 1,
      instanceId: 'i1',
      lastSeenAt: 'now',
    })
    for (let i = 0; i < 3; i++) recordHealthFailure(db, 'p1', 'timeout')
    const plan = planTick(db, {
      nowMs: 1_000_000,
      policy: POLICY,
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map(),
    })
    expect(plan.actions[0]).toMatchObject({ kind: 'restart', projectId: 'p1' })
  })

  it('does NOT restart within cooldown', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'running',
      boundPort: 3500,
      childPid: 1,
      instanceId: 'i1',
      lastSeenAt: 'now',
    })
    for (let i = 0; i < 5; i++) recordHealthFailure(db, 'p1', 'timeout')
    const plan = planTick(db, {
      nowMs: 1_010_000,
      policy: POLICY,
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map([['p1', 1_000_000]]),
    })
    // Still planning the probe (next tick), but no restart
    expect(plan.actions.find((a) => a.kind === 'restart')).toBeUndefined()
  })

  it('plans a suspend when restart-policy reports crash-loop', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'running',
      boundPort: 3500,
      childPid: 1,
      instanceId: 'i1',
      lastSeenAt: 'now',
    })
    for (let i = 0; i < 5; i++) recordHealthFailure(db, 'p1', 'crash')
    const plan = planTick(db, {
      nowMs: 500_000,
      policy: POLICY,
      restartHistoryByProject: new Map([['p1', [200_000, 300_000, 400_000]]]),
      lastRestartByProject: new Map([['p1', 400_000]]),
    })
    expect(plan.actions[0]).toMatchObject({ kind: 'suspend', projectId: 'p1' })
  })

  it('skips a suspended project while its retry backoff is still running', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'failed',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: new Date(1_000_000).toISOString(),
    })
    const plan = planTick(db, {
      nowMs: 1_000_000 + 60_000,
      policy: { ...POLICY, failedRetryBackoffMs: 300_000 },
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map(),
    })
    expect(plan.actions).toEqual([])
  })

  it('re-spawns a suspended project once its retry backoff elapses', () => {
    // Regression (2026-10-12): `failed` used to be terminal "until the operator
    // re-registers" — but `registerProject` never writes `status`, so there was
    // no such re-registration, and three children stayed dead for ~11 hours
    // refusing every memory write. The budget that suspends them is spent by
    // machine conditions (a stalled `taskkill`) as readily as by a crash loop,
    // so suspension must expire.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'failed',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: new Date(1_000_000).toISOString(),
    })
    const plan = planTick(db, {
      nowMs: 1_000_000 + 300_001,
      policy: { ...POLICY, failedRetryBackoffMs: 300_000 },
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map(),
    })
    expect(plan.actions).toEqual([{ kind: 'spawn', projectId: 'p1', projectRoot: '/repo/a' }])
  })

  it('re-arms the retry backoff from the in-memory attempt stamp, not just last_seen_at', () => {
    // A retry whose spawn throws before any registry write (the anchored port
    // is still held by a zombie) leaves `last_seen_at` frozen at the
    // suspension. Without the attempt stamp the planner would re-plan the
    // spawn — port probe, throw, error log — every 5s tick until the zombie
    // died, instead of once per backoff.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'failed',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: new Date(1_000_000).toISOString(),
    })
    const failedAttemptAt = 1_000_000 + 300_001 // first retry fired, spawn threw
    const plan = planTick(db, {
      nowMs: failedAttemptAt + 5_000, // next tick
      policy: { ...POLICY, failedRetryBackoffMs: 300_000 },
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map([['p1', failedAttemptAt]]),
    })
    expect(plan.actions).toEqual([])

    const afterBackoff = planTick(db, {
      nowMs: failedAttemptAt + 300_001,
      policy: { ...POLICY, failedRetryBackoffMs: 300_000 },
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map([['p1', failedAttemptAt]]),
    })
    expect(afterBackoff.actions).toEqual([
      { kind: 'spawn', projectId: 'p1', projectRoot: '/repo/a' },
    ])
  })

  it('retries a suspended project immediately when no suspension time is readable', () => {
    // An operator (or an older row) can leave `failed` with no parsable
    // `last_seen_at`. There is no backoff to measure, and the only intent that
    // can have put it there is one that wants it back.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'failed',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: null,
    })
    const plan = planTick(db, {
      nowMs: 1_000,
      policy: POLICY,
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map(),
    })
    expect(plan.actions).toEqual([{ kind: 'spawn', projectId: 'p1', projectRoot: '/repo/a' }])
  })

  it('puts the no-port respawn under the restart budget: cooldown paces it', () => {
    // A child that exits at boot never records a probe failure (claimChild
    // resets the counter, and a dead child is never probed), so it lands in
    // 'failing' with no bound port and health_failures 0. That used to plan a
    // plain spawn EVERY tick, forever, without charging a restart slot.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'failing',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: 'now',
    })
    const inCooldown = planTick(db, {
      nowMs: 1_010_000,
      policy: POLICY,
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map([['p1', 1_000_000]]), // spawned 10s ago
    })
    expect(inCooldown.actions).toEqual([])

    const afterCooldown = planTick(db, {
      nowMs: 1_000_000 + 30_001,
      policy: POLICY,
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map([['p1', 1_000_000]]),
    })
    expect(afterCooldown.actions[0]).toMatchObject({ kind: 'restart', projectId: 'p1' })
  })

  it('suspends a boot-crash loop once the no-port respawns exhaust the budget', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'failing',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: 'now',
    })
    const plan = planTick(db, {
      nowMs: 500_000,
      policy: POLICY,
      restartHistoryByProject: new Map([['p1', [200_000, 300_000, 400_000]]]),
      lastRestartByProject: new Map([['p1', 400_000]]),
    })
    expect(plan.actions[0]).toMatchObject({ kind: 'suspend', projectId: 'p1' })
  })

  it('emits actions for multiple projects in stable order', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    registerProject(db, { projectId: 'p2', projectRoot: '/repo/b' })
    registerProject(db, { projectId: 'p3', projectRoot: '/repo/c' })
    const plan = planTick(db, {
      nowMs: 1000,
      policy: POLICY,
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map(),
    })
    const ids = plan.actions.map((a) => a.projectId)
    expect(ids).toEqual(['p1', 'p2', 'p3'])
  })

  it('skips a stopped project — terminal until `meta reset`', () => {
    // 'stopped' is deliberate operator intent, not a health verdict, so unlike
    // 'failed' it does NOT expire into a retry — it stays terminal until the
    // operator says otherwise (`meta reset`). This test asserts that
    // policy: stopped projects are skipped.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    updateChildState(db, 'p1', {
      status: 'stopped',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: new Date(0).toISOString(),
    })
    const plan: TickPlan = planTick(db, {
      nowMs: 10_000_000,
      policy: POLICY,
      restartHistoryByProject: new Map(),
      lastRestartByProject: new Map(),
    })
    expect(plan.actions).toEqual([])
  })
})

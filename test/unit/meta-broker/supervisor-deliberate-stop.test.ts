/**
 * Root cause (bug #1): a deliberately stopped child was resurrected.
 *
 * `claimChild`'s exit handler recorded EVERY child exit as `status = 'failing'`
 * — including an exit the supervisor itself asked for. `planForProject` treats
 * `failing` as restart-worthy, so the registry row was overwritten within one
 * tick and the child came straight back. Observed live: 12 children were set
 * to `stopped` by hand and their PIDs killed; ALL 12 were back inside 50
 * seconds. There was, in practice, no way to stop a child broker at all.
 *
 * This file exercises the real `createMetaSupervisor` against fake child
 * processes, so the exit handler under test is the shipped one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import Database from 'better-sqlite3'
import {
  applyMetaSchema,
  getProject,
  registerProject,
  updateChildState,
} from '../../../src/meta-broker/registry.js'
import {
  createMetaSupervisor,
  type MetaSupervisor,
  type ChildProbeResult,
} from '../../../src/meta-broker/meta-supervisor.js'

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000

/** A stand-in for a forked child broker: emits `exit` when we say so. */
class FakeChild extends EventEmitter {
  public killed = false
  public exitCode: number | null = null
  public signalCode: NodeJS.Signals | null = null
  /** How many times anything tried to stop this process. */
  public killAttempts = 0
  constructor(public readonly pid: number) {
    super()
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killAttempts += 1
    this.killed = true
    this.signalCode = signal ?? 'SIGTERM'
    // A real SIGTERM is asynchronous; emitting on the next turn of the loop
    // keeps the ordering honest (the stopper writes its row, THEN exit fires).
    setImmediate(() => this.emit('exit', null, signal ?? 'SIGTERM'))
    return true
  }
}

let db: Database.Database
let spawned: FakeChild[] = []
let nextPid = 1000
let supervisor: MetaSupervisor | null = null

/** Idle age the fake child reports, per port. Undefined = field not reported. */
const idleByPort = new Map<number, number | undefined>()

/**
 * A child whose exit lands while it is STILL the live entry — the shape the
 * real incident took (the registry row was already `stopped`, the PID was
 * killed from outside, and the supervisor's handler then overwrote the row).
 * Isolates the deliberate-stop flag from the live-map pid guard, which would
 * otherwise mask it.
 */
class SyncExitChild extends FakeChild {
  override kill(signal?: NodeJS.Signals): boolean {
    this.killAttempts += 1
    this.killed = true
    this.signalCode = signal ?? 'SIGTERM'
    this.emit('exit', null, signal ?? 'SIGTERM')
    return true
  }
}

/**
 * A child that ignores every signal — the observed Windows case
 * (`pid ... still alive after 10000ms`, `taskkill ETIMEDOUT`). Records the
 * attempts so a test can assert escalation and pacing.
 */
class UnkillableChild extends FakeChild {
  override kill(_signal?: NodeJS.Signals): boolean {
    this.killAttempts += 1
    this.killed = true
    return false
  }
}

/** Ignores SIGTERM, dies on SIGKILL. */
class SigtermDeafChild extends FakeChild {
  override kill(signal?: NodeJS.Signals): boolean {
    this.killAttempts += 1
    this.killed = true
    if (signal === 'SIGKILL') {
      this.signalCode = 'SIGKILL'
      setImmediate(() => this.emit('exit', null, 'SIGKILL'))
      return true
    }
    return false
  }
}

let spawnSyncExit = false
let spawnUnkillable = false
let spawnIgnoresSigterm = false
let forceStopCalls = 0

function makeChild(pid: number): FakeChild {
  if (spawnSyncExit) return new SyncExitChild(pid)
  if (spawnUnkillable) return new UnkillableChild(pid)
  if (spawnIgnoresSigterm) return new SigtermDeafChild(pid)
  return new FakeChild(pid)
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (): ChildProcess => {
      const child = makeChild(nextPid++)
      spawned.push(child)
      return child as unknown as ChildProcess
    },
  }
})

const probe = async (port: number): Promise<ChildProbeResult> => ({
  ok: true,
  lastRequestAgeMs: idleByPort.get(port) ?? null,
})

function makeSupervisor(idleTimeoutMs?: number): MetaSupervisor {
  supervisor = createMetaSupervisor({
    db,
    brokerEntry: '/fake/dist/cli.js',
    projectDbDir: '/fake/projects',
    intervalMs: 60_000,
    childProbe: probe,
    // Deterministic: the real bind-probe would consult actual ports on this
    // machine, where 3500 is a LIVE broker. `false` means "the port is free",
    // which is what a successfully stopped child leaves behind.
    isPortInUse: async () => false,
    // The last-resort force stop must not run `taskkill` against a fake pid.
    forceStopPid: () => {
      forceStopCalls += 1
    },
    ...(idleTimeoutMs === undefined
      ? {}
      : {
          policy: {
            minFailures: 3,
            cooldownMs: 30_000,
            maxRestartsPerWindow: 3,
            windowMs: 600_000,
            idleTimeoutMs,
          },
        }),
  })
  return supervisor
}

/** Let any setImmediate-scheduled `exit` handlers run. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(() => setImmediate(r)))

beforeEach(() => {
  db = new Database(':memory:')
  applyMetaSchema(db)
  spawned = []
  nextPid = 1000
  idleByPort.clear()
  supervisor = null
  spawnSyncExit = false
  spawnUnkillable = false
  spawnIgnoresSigterm = false
  forceStopCalls = 0
})

afterEach(() => {
  supervisor = null
  db.close()
  vi.restoreAllMocks()
})

describe('deliberate stops are not recorded as failures (root cause)', () => {
  it('ACCEPTANCE: an idle-reaped child stays stopped — its exit does NOT write `failing`', async () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    const sup = makeSupervisor(FOUR_HOURS_MS)

    // Tick 1: spawn. Tick 2: probe promotes to running and reports idleness.
    await sup.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('starting')
    idleByPort.set(3500, FOUR_HOURS_MS + 60_000)
    await sup.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('running')

    // Tick 3: the reap.
    await sup.tickOnce()
    expect(getProject(db, 'p1')).toMatchObject({ status: 'stopped', stoppedReason: 'idle' })
    expect(spawned[0]!.killed).toBe(true)

    // The exact moment the old code broke: the child's exit event lands.
    await flush()
    expect(
      getProject(db, 'p1'),
      'exit handler must not overwrite the deliberate stop',
    ).toMatchObject({ status: 'stopped', stoppedReason: 'idle' })

    // ACCEPTANCE: no respawn on its own, no matter how many ticks run.
    await sup.tickOnce()
    await sup.tickOnce()
    await sup.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('stopped')
    expect(spawned).toHaveLength(1)
  })

  it('a child killed from OUTSIDE is still recorded as failing (negative control)', async () => {
    // The fix must only suppress stops WE asked for. An unexpected death is
    // still a health event and must stay restartable.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    const sup = makeSupervisor(FOUR_HOURS_MS)
    await sup.tickOnce()
    await sup.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('running')

    spawned[0]!.emit('exit', 1, null)
    await flush()
    expect(getProject(db, 'p1')?.status).toBe('failing')
  })

  it('the deliberate-stop marker alone protects the reap, with no help from the live-map guard', async () => {
    // Isolation test. In the normal path the live-map pid check happens to
    // fire first, which would mask a regression in the marker. Here the exit
    // lands while the child is STILL the live entry — the shape of the real
    // incident — so the ONLY thing standing between a deliberate stop and a
    // `failing` row is `intentionalStops`.
    spawnSyncExit = true
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    const sup = makeSupervisor(FOUR_HOURS_MS)
    await sup.tickOnce()
    idleByPort.set(3500, FOUR_HOURS_MS + 1)
    await sup.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('running')

    await sup.tickOnce()
    await flush()
    expect(getProject(db, 'p1')).toMatchObject({ status: 'stopped', stoppedReason: 'idle' })
  })

  it('a suspended (failed) child is not downgraded to failing by its own exit', async () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    const sup = makeSupervisor(0)
    await sup.tickOnce()
    await sup.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('running')

    // Drive the restart policy past its budget so the planner suspends.
    const failing = createMetaSupervisor({
      db,
      brokerEntry: '/fake/dist/cli.js',
      projectDbDir: '/fake/projects',
      intervalMs: 60_000,
      childProbe: async () => ({ ok: false, lastRequestAgeMs: null }),
      policy: {
        minFailures: 1,
        cooldownMs: 0,
        maxRestartsPerWindow: 0,
        windowMs: 600_000,
      },
    })
    await failing.tickOnce()
    await failing.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('failed')

    await flush()
    expect(getProject(db, 'p1')?.status, 'exit must not clobber the suspension').toBe('failed')
  })

  it('ACCEPTANCE: an unverified suspension is stranded but DIAGNOSABLE, never split-brained', async () => {
    // Reshaped after review, then corrected again. The earlier version
    // asserted the MECHANISM ("status becomes failed") and never the
    // consequence, which is why it missed a real door: `updateChildState`
    // nulls `bound_port` but not `desired_port`, and `stickyDesiredPort` falls
    // back to `desired_port` — so a suspension whose kill did not land leaves
    // an anchor the surviving process still holds, and every backoff retry
    // hits `spawnChild`'s refusal.
    //
    // The tempting cure — drop the anchor, take a fresh port — is WRONG and is
    // what this test now pins. The occupant of a project's own anchor is most
    // likely that project's own surviving child, so spawning elsewhere puts
    // two brokers on one per-project SQLite DB. `same-port-recovery.test.ts`
    // already encodes that invariant; this asserts the honest outcome instead:
    // no second broker, and a recorded reason an operator can actually see.
    const HELD = 46001
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: HELD })
    updateChildState(db, 'p1', {
      status: 'failed',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: new Date(0).toISOString(),
    })

    supervisor = createMetaSupervisor({
      db,
      brokerEntry: '/fake/dist/cli.js',
      projectDbDir: '/fake/projects',
      intervalMs: 60_000,
      childProbe: probe,
      isPortInUse: async (p) => p === HELD,
      forceStopPid: () => {
        forceStopCalls += 1
      },
      policy: {
        minFailures: 3,
        cooldownMs: 30_000,
        maxRestartsPerWindow: 3,
        windowMs: 600_000,
        failedRetryBackoffMs: 1,
        idleTimeoutMs: 0,
      },
    })

    await supervisor.tickOnce()

    // No split-brain: nothing was spawned onto a different port.
    expect(spawned, 'must NOT start a second broker for this project').toHaveLength(0)
    const row = getProject(db, 'p1')
    expect(row?.desiredPort, 'the anchor stays reserved for this project').toBe(HELD)
    // Diagnosable: the refusal is recorded, not merely thrown into the log.
    expect(row?.lastError).toContain(String(HELD))
    expect(row?.lastError).toMatch(/occupied/i)
  }, 30_000)

  it('a suspension is still recorded when the stop cannot be verified (asymmetry with the reap)', async () => {
    // Deliberate asymmetry. A reap is optional and writes a near-terminal
    // `stopped` that implies a free port, so an unverified one must refuse. A
    // suspension is a HEALTH VERDICT on a project that is already failing, and
    // `failed` retries on a backoff rather than latching — so refusing to
    // record it would just leave the project re-deciding the same suspension
    // every tick forever.
    spawnUnkillable = true
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    const up = makeSupervisor(0)
    await up.tickOnce()
    await up.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('running')

    supervisor = createMetaSupervisor({
      db,
      brokerEntry: '/fake/dist/cli.js',
      projectDbDir: '/fake/projects',
      intervalMs: 60_000,
      childProbe: async () => ({ ok: false, lastRequestAgeMs: null }),
      isPortInUse: async () => false,
      forceStopPid: () => {
        forceStopCalls += 1
      },
      policy: {
        minFailures: 1,
        cooldownMs: 0,
        maxRestartsPerWindow: 0,
        windowMs: 600_000,
      },
    })
    await supervisor.tickOnce()
    await supervisor.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('failed')
  }, 30_000)

  it('a clean supervisor shutdown leaves children `registered`, not `failing`', async () => {
    // Same bug class: during stop()'s drain window every child exited while
    // still in the live map, so each was written `failing` — a false health
    // verdict charged against the restart budget on the next start.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    const sup = makeSupervisor(0)
    await sup.tickOnce()
    await sup.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('running')

    await sup.stop()
    await flush()
    expect(getProject(db, 'p1')).toMatchObject({
      status: 'registered',
      boundPort: null,
      childPid: null,
    })
  })
})

describe('idle detection via the probe', () => {
  it('never reaps when the child does not report an idle age', async () => {
    // A child too old to carry `last_request_age_seconds` must keep running,
    // not be reaped on an assumption.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    const sup = makeSupervisor(1)
    await sup.tickOnce()
    await sup.tickOnce()
    for (let i = 0; i < 5; i++) await sup.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('running')
  })

  it('never reaps on a FAILED probe, however long the child has been quiet', async () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    let ok = true
    supervisor = createMetaSupervisor({
      db,
      brokerEntry: '/fake/dist/cli.js',
      projectDbDir: '/fake/projects',
      intervalMs: 60_000,
      childProbe: async () => ({
        ok,
        lastRequestAgeMs: ok ? FOUR_HOURS_MS * 10 : null,
      }),
      policy: {
        minFailures: 100,
        cooldownMs: 600_000,
        maxRestartsPerWindow: 100,
        windowMs: 600_000,
        idleTimeoutMs: 0,
      },
    })
    await supervisor.tickOnce()
    ok = false
    await supervisor.tickOnce()
    await supervisor.tickOnce()
    expect(getProject(db, 'p1')?.status).not.toBe('stopped')
  })

  it('a woken child gets a fresh idle clock, so wake and reap cannot thrash', async () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    const sup = makeSupervisor(FOUR_HOURS_MS)
    await sup.tickOnce()
    idleByPort.set(3500, FOUR_HOURS_MS + 1)
    await sup.tickOnce()
    await sup.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('stopped')
    await flush()

    // Demand arrives: the resolve route's wake. The child now reports itself
    // busy again (its in-memory clock reset on start).
    updateChildState(db, 'p1', {
      status: 'registered',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: null,
    })
    idleByPort.set(3500, 0)

    await sup.tickOnce()
    expect(spawned).toHaveLength(2)
    await sup.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('running')
    await sup.tickOnce()
    expect(getProject(db, 'p1')?.status, 'must not be reaped straight back').toBe('running')
  })
})

describe('a stop that cannot be verified is REFUSED, not recorded (S1)', () => {
  /**
   * The failure this closes. The reap used to write `stopped` for a kill it
   * never verified. A `stopped` row asserts the port is free, and `spawnChild`
   * refuses to respawn onto an occupied port — so a reap whose kill did not
   * land made the project permanently unspawnable. Every wake then failed,
   * `/api/meta/resolve` never returned `resolved:true`, and the session latched
   * `global:fallback`: writes refused for its whole life. That is the precise
   * outcome idle reaping was supposed to make impossible, reintroduced by the
   * feature meant to prevent it.
   */

  it('refuses the reap when the child ignores SIGTERM, SIGKILL and force-stop', async () => {
    spawnUnkillable = true
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    const sup = makeSupervisor(FOUR_HOURS_MS)
    await sup.tickOnce()
    idleByPort.set(3500, FOUR_HOURS_MS + 1)
    await sup.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('running')

    await sup.tickOnce() // the reap attempt
    await flush()

    const row = getProject(db, 'p1')
    expect(row?.status, 'an unverified stop must not be recorded').toBe('running')
    expect(row?.stoppedReason).toBeNull()
    expect(row?.boundPort, 'the project must keep its address').toBe(3500)
    expect(forceStopCalls, 'escalated all the way to the force stop').toBeGreaterThan(0)
  }, 30_000)

  it('ACCEPTANCE: a refused reap leaves the project respawnable, not deadlocked', async () => {
    // The whole point. After a refusal the row still describes a live, healthy
    // child on its own port, so routing keeps resolving it and no session ever
    // reaches the fallback path.
    spawnUnkillable = true
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    const sup = makeSupervisor(FOUR_HOURS_MS)
    await sup.tickOnce()
    idleByPort.set(3500, FOUR_HOURS_MS + 1)
    await sup.tickOnce()
    await sup.tickOnce()
    await flush()

    const row = getProject(db, 'p1')
    expect(row?.status).toBe('running')
    expect(row?.boundPort).toBe(3500)
    // `running` + a bound port is exactly what /api/meta/resolve needs to
    // answer resolved:true.
    expect(row?.status === 'running' && row.boundPort !== null).toBe(true)
  }, 30_000)

  it('refuses when there is no tracked child at all (orphan after a supervisor restart)', async () => {
    // Judge's repro: registry says `running` with a health-verified port, but
    // the live map is empty because the previous supervisor incarnation died
    // and its child survived. There is nothing we can safely kill, so there is
    // nothing we may claim to have killed.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    updateChildState(db, 'p1', {
      status: 'running',
      boundPort: 3500,
      childPid: 99999,
      instanceId: 'iid-survivor',
      lastSeenAt: new Date().toISOString(),
    })
    const sup = makeSupervisor(FOUR_HOURS_MS)
    idleByPort.set(3500, FOUR_HOURS_MS * 2)

    await sup.tickOnce() // probe records idleness
    await sup.tickOnce() // reap attempt — must refuse
    await flush()

    expect(spawned, 'nothing should have been spawned').toHaveLength(0)
    expect(getProject(db, 'p1')).toMatchObject({
      status: 'running',
      stoppedReason: null,
      boundPort: 3500,
    })
  }, 30_000)

  it('escalates to SIGKILL and succeeds when SIGTERM alone is ignored', async () => {
    spawnIgnoresSigterm = true
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    const sup = makeSupervisor(FOUR_HOURS_MS)
    await sup.tickOnce()
    idleByPort.set(3500, FOUR_HOURS_MS + 1)
    await sup.tickOnce()
    await sup.tickOnce()
    await flush()

    expect(spawned[0]!.signalCode).toBe('SIGKILL')
    expect(getProject(db, 'p1')).toMatchObject({ status: 'stopped', stoppedReason: 'idle' })
  }, 30_000)

  it('refuses when the process exited but its PORT is still held', async () => {
    // The half of the verification called "load-bearing" in review and then
    // left entirely untested: every other supervisor test stubs the bind-probe
    // always-free. A dead process whose port is still occupied — a surviving
    // grandchild, a socket not yet released — produces exactly the same
    // unspawnable project as a kill that never landed, because `spawnChild`
    // tests this identical condition.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    // Free while the child starts; stuck from the moment the reap begins.
    let portStuck = false
    supervisor = createMetaSupervisor({
      db,
      brokerEntry: '/fake/dist/cli.js',
      projectDbDir: '/fake/projects',
      intervalMs: 60_000,
      childProbe: probe,
      // The process dies cleanly; the PORT does not come back.
      isPortInUse: async () => portStuck,
      forceStopPid: () => {
        forceStopCalls += 1
      },
      policy: {
        minFailures: 3,
        cooldownMs: 30_000,
        maxRestartsPerWindow: 3,
        windowMs: 600_000,
        idleTimeoutMs: FOUR_HOURS_MS,
      },
    })
    await supervisor.tickOnce()
    idleByPort.set(3500, FOUR_HOURS_MS + 1)
    await supervisor.tickOnce()
    expect(getProject(db, 'p1')?.status).toBe('running')

    portStuck = true
    await supervisor.tickOnce() // reap attempt
    await flush()

    // The child really did exit — this is not the "unkillable" case.
    expect(spawned[0]!.killed).toBe(true)
    // ...but the refusal must still fire, because the port tells the truth
    // about whether a respawn could succeed.
    expect(getProject(db, 'p1')).toMatchObject({
      status: 'running',
      stoppedReason: null,
      boundPort: 3500,
    })
  }, 30_000)

  it('paces a refused reap instead of retrying it every tick', async () => {
    // A refusal costs seconds of serial tick time. Hammering it would make the
    // load that caused the refusal worse.
    spawnUnkillable = true
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
    const sup = makeSupervisor(FOUR_HOURS_MS)
    await sup.tickOnce()
    idleByPort.set(3500, FOUR_HOURS_MS + 1)
    await sup.tickOnce()

    await sup.tickOnce()
    const attemptsAfterFirst = spawned[0]!.killAttempts
    expect(attemptsAfterFirst).toBeGreaterThan(0)

    // Subsequent ticks inside the cooldown must not touch it again.
    await sup.tickOnce()
    await sup.tickOnce()
    expect(spawned[0]!.killAttempts).toBe(attemptsAfterFirst)
  }, 30_000)
})

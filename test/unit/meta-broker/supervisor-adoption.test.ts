/**
 * Orphan reconciliation — adopting a live child this supervisor did not spawn.
 *
 * Two failures shared one root cause, and this closes both:
 *
 *  1. A child is spawned `detached:false`, which on Windows does NOT kill it
 *     with its parent. After a non-clean supervisor restart the orphan serves
 *     happily on the anchored port while the new supervisor's `live` map is
 *     empty. Nothing could stop it — the exact resource leak idle reaping
 *     exists to remove (16 brokers, ~1.47 GB, 12 of them for dead projects).
 *  2. An unverified suspension left a row whose pinned port is held by the
 *     child we failed to kill. `stickyDesiredPort` returns that anchor, so
 *     every retry hit `spawnChild`'s occupied-anchor refusal forever; routing
 *     answered `child-failed`, which is NOT retryable, so sessions latched
 *     `global:fallback` on the first attempt with no grace.
 *
 * The refusal was never wrong — spawning a SECOND broker onto one project's
 * SQLite DB is worse than a project that will not start. What was missing was
 * its other arm: when the occupant PROVES it is this project's child, take it
 * over instead of starting a rival.
 *
 * These tests assert CONSEQUENCES (is the project managed? reapable? never
 * duplicated?) rather than mechanisms.
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
const ANCHOR = 47101

/**
 * The already-running child: a process on a port, with an identity, that this
 * supervisor never spawned. Modelled rather than forked, because what matters
 * is exactly what the supervisor can observe about it — an identity-checked
 * probe, a bind-probe, and signals to a pid.
 */
interface Occupant {
  port: number
  instanceId: string
  /** What it reports about ITSELF on /api/health. null = too old to report. */
  selfReportedPid: number | null
  /** The pid signals actually reach. */
  realPid: number
  alive: boolean
  /** Does it answer /api/health at all? A wedged child holds its socket but not its event loop. */
  answersHealth: boolean
  idleMs: number | null
  /** Ignores signals (the observed taskkill-ETIMEDOUT case). */
  unkillable: boolean
}

let db: Database.Database
let supervisor: MetaSupervisor | null = null
let occupant: Occupant | null = null
let spawnedChildren: FakeChild[] = []
let nextPid = 9000

class FakeChild extends EventEmitter {
  public exitCode: number | null = null
  public signalCode: NodeJS.Signals | null = null
  constructor(public readonly pid: number) {
    super()
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.signalCode = signal ?? 'SIGTERM'
    setImmediate(() => this.emit('exit', null, signal ?? 'SIGTERM'))
    return true
  }
}

/** A spawned child that ignores every signal — the taskkill-ETIMEDOUT case. */
class UnkillableSpawnedChild extends FakeChild {
  override kill(_signal?: NodeJS.Signals): boolean {
    return false
  }
}

let spawnUnkillable = false

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (): ChildProcess => {
      const child = spawnUnkillable
        ? new UnkillableSpawnedChild(nextPid++)
        : new FakeChild(nextPid++)
      spawnedChildren.push(child)
      return child as unknown as ChildProcess
    },
  }
})

function makeOccupant(over: Partial<Occupant> = {}): Occupant {
  return {
    port: ANCHOR,
    instanceId: 'iid-survivor',
    selfReportedPid: 4242,
    realPid: 4242,
    alive: true,
    answersHealth: true,
    idleMs: 0,
    unkillable: false,
    ...over,
  }
}

const probe = async (port: number, instanceId: string): Promise<ChildProbeResult> => {
  const o = occupant
  if (o && o.alive && o.answersHealth && o.port === port && o.instanceId === instanceId) {
    return { ok: true, lastRequestAgeMs: o.idleMs, pid: o.selfReportedPid }
  }
  // Also answer for children this supervisor spawned itself.
  const spawned = spawnedChildren.at(-1)
  if (spawned && !o) return { ok: true, lastRequestAgeMs: 0, pid: spawned.pid }
  return { ok: false, lastRequestAgeMs: null, pid: null }
}

function makeSupervisor(idleTimeoutMs = 0, failedRetryBackoffMs?: number): MetaSupervisor {
  supervisor = createMetaSupervisor({
    db,
    brokerEntry: '/fake/dist/cli.js',
    projectDbDir: '/fake/projects',
    intervalMs: 3_600_000, // stepped by hand
    childProbe: probe,
    isPortInUse: async (p) => occupant !== null && occupant.alive && occupant.port === p,
    forceStopPid: (pid) => {
      if (occupant && occupant.realPid === pid && !occupant.unkillable) occupant.alive = false
    },
    policy: {
      minFailures: 1000,
      cooldownMs: 600_000,
      maxRestartsPerWindow: 1000,
      windowMs: 600_000,
      idleTimeoutMs,
      ...(failedRetryBackoffMs === undefined ? {} : { failedRetryBackoffMs }),
    },
  })
  return supervisor
}

beforeEach(() => {
  db = new Database(':memory:')
  applyMetaSchema(db)
  occupant = null
  supervisor = null
  spawnedChildren = []
  spawnUnkillable = false
  nextPid = 9000
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    const o = occupant
    if (!o || o.realPid !== pid) {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    }
    if (!o.alive) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    if (sig === 0) return true
    if (!o.unkillable) o.alive = false
    return true
  }) as unknown as typeof process.kill)
})

afterEach(() => {
  supervisor = null
  db.close()
  vi.restoreAllMocks()
})

/** The registry row a child leaves behind when its supervisor dies under it. */
function seedSurvivedSupervisorRestart(): void {
  registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: ANCHOR })
  updateChildState(db, 'p1', {
    status: 'running',
    boundPort: ANCHOR,
    childPid: 4242,
    instanceId: 'iid-survivor',
    lastSeenAt: new Date().toISOString(),
  })
}

describe('a child that outlived its supervisor is adopted, not abandoned', () => {
  it('ACCEPTANCE: an orphan is taken over and then reaped when it goes idle', async () => {
    // The leak, end to end. Before adoption this child was probed forever,
    // never managed, and never reapable: `stopChildVerified` had no handle, so
    // every reap refused and the memory was never reclaimed.
    occupant = makeOccupant({ idleMs: FOUR_HOURS_MS * 2 })
    seedSurvivedSupervisorRestart()
    const sup = makeSupervisor(FOUR_HOURS_MS)

    await sup.tickOnce() // probe -> identity verified -> adopt
    expect(sup.livePids().get('p1'), 'the orphan is now managed').toBe(4242)
    expect(spawnedChildren, 'adoption must never start a rival broker').toHaveLength(0)
    expect(getProject(db, 'p1')).toMatchObject({
      status: 'running',
      boundPort: ANCHOR,
      childPid: 4242,
    })

    await sup.tickOnce() // idle past the threshold -> reap
    expect(occupant.alive, 'the adopted child must actually be stopped').toBe(false)
    expect(getProject(db, 'p1')).toMatchObject({ status: 'stopped', stoppedReason: 'idle' })
  }, 30_000)

  it('ACCEPTANCE: an adopted child that is still busy is kept, not reaped', async () => {
    occupant = makeOccupant({ idleMs: 0 })
    seedSurvivedSupervisorRestart()
    const sup = makeSupervisor(FOUR_HOURS_MS)

    await sup.tickOnce()
    await sup.tickOnce()
    await sup.tickOnce()
    expect(occupant.alive).toBe(true)
    expect(getProject(db, 'p1')?.status).toBe('running')
  }, 30_000)

  it("uses the child's OWN idle clock, which survived the supervisor", async () => {
    // The reading lives in the child's memory (`broker/request-activity.ts`)
    // and is reported over /api/health, so an adopted child is immediately
    // reapable on the strength of time it was idle BEFORE we knew about it.
    // That is the point: those are exactly the hours we are trying to reclaim.
    occupant = makeOccupant({ idleMs: FOUR_HOURS_MS + 60_000 })
    seedSurvivedSupervisorRestart()
    const sup = makeSupervisor(FOUR_HOURS_MS)

    await sup.tickOnce()
    await sup.tickOnce()
    expect(getProject(db, 'p1')).toMatchObject({ status: 'stopped', stoppedReason: 'idle' })
  }, 30_000)

  it('releases the live slot when an adopted child dies on its own', async () => {
    // An adopted child has no `exit` event. Without the sweep its dead entry
    // would linger in `live` and block the `spawn` action forever.
    occupant = makeOccupant({ idleMs: 0 })
    seedSurvivedSupervisorRestart()
    const sup = makeSupervisor(0)

    await sup.tickOnce()
    expect(sup.livePids().has('p1')).toBe(true)

    occupant.alive = false
    await sup.tickOnce()
    expect(sup.livePids().has('p1'), 'the dead adopted entry must be released').toBe(false)
  }, 30_000)
})

describe('adoption refuses anything it cannot positively identify', () => {
  it('NEGATIVE CONTROL: an occupant echoing a DIFFERENT identity is refused', async () => {
    // A stranger on the port, or this project's port taken by another
    // project's child. Adopting it would hand one project another's broker.
    occupant = makeOccupant({ instanceId: 'someone-elses-instance' })
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: ANCHOR })
    updateChildState(db, 'p1', {
      status: 'failed',
      boundPort: null,
      childPid: null,
      instanceId: 'iid-ours',
      lastSeenAt: new Date(0).toISOString(),
    })
    const sup = makeSupervisor(0)

    await sup.tickOnce()
    expect(sup.livePids().has('p1'), 'must NOT adopt a stranger').toBe(false)
    expect(spawnedChildren, 'must NOT start a rival onto an occupied port').toHaveLength(0)
    expect(occupant.alive, 'must NOT kill a process it cannot identify').toBe(true)
    expect(getProject(db, 'p1')?.lastError).toMatch(/could not identify/i)
  }, 30_000)

  it('NEGATIVE CONTROL: an occupant that answers nothing at all is refused', async () => {
    // A wedged child holds its listening socket while its event loop is
    // stuck, so "does not answer" can NEVER be read as "is not ours".
    occupant = makeOccupant({ answersHealth: false })
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: ANCHOR })
    updateChildState(db, 'p1', {
      status: 'failed',
      boundPort: null,
      childPid: null,
      instanceId: 'iid-survivor',
      lastSeenAt: new Date(0).toISOString(),
    })
    const sup = makeSupervisor(0)

    await sup.tickOnce()
    expect(sup.livePids().has('p1')).toBe(false)
    expect(spawnedChildren).toHaveLength(0)
    expect(getProject(db, 'p1')?.desiredPort, 'the anchor stays reserved').toBe(ANCHOR)
  }, 30_000)

  it('NEGATIVE CONTROL: a cold start with no stored identity is refused unchanged', async () => {
    // Nothing to verify against. This is the invariant
    // `same-port-recovery.test.ts` pins ("never silently reallocates an
    // occupied anchor on a cold start"), and adoption must not weaken it.
    occupant = makeOccupant()
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: ANCHOR })
    const sup = makeSupervisor(0)

    await sup.tickOnce()
    expect(spawnedChildren).toHaveLength(0)
    expect(sup.livePids().has('p1')).toBe(false)
    expect(getProject(db, 'p1')?.desiredPort).toBe(ANCHOR)
  }, 30_000)

  it('NEGATIVE CONTROL: an identified occupant reporting no pid is refused', async () => {
    // Adopting a child we could never stop would just re-create the leak under
    // a different name, and would let a later reap write `stopped` for a kill
    // that could not happen.
    occupant = makeOccupant({ selfReportedPid: null })
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: ANCHOR })
    updateChildState(db, 'p1', {
      status: 'failed',
      boundPort: null,
      childPid: null,
      instanceId: 'iid-survivor',
      lastSeenAt: new Date(0).toISOString(),
    })
    const sup = makeSupervisor(0)

    await sup.tickOnce()
    expect(sup.livePids().has('p1')).toBe(false)
    expect(spawnedChildren).toHaveLength(0)
  }, 30_000)

  it('NEGATIVE CONTROL: an operator-stopped project is never resurrected', async () => {
    // Adoption must not become a back door around deliberate operator intent.
    // `stopped` yields no action from the planner at all, so nothing probes
    // and nothing adopts — asserted here rather than assumed.
    occupant = makeOccupant()
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: ANCHOR })
    updateChildState(db, 'p1', {
      status: 'stopped',
      stoppedReason: 'operator',
      boundPort: null,
      childPid: null,
      instanceId: 'iid-survivor',
      lastSeenAt: new Date(0).toISOString(),
    })
    const sup = makeSupervisor(0)

    for (let i = 0; i < 3; i++) await sup.tickOnce()
    expect(sup.livePids().has('p1'), 'an operator stop must stay stopped').toBe(false)
    expect(spawnedChildren).toHaveLength(0)
    expect(getProject(db, 'p1')).toMatchObject({ status: 'stopped', stoppedReason: 'operator' })
  }, 30_000)
})

describe('the suspend door: an unverified suspension is recoverable', () => {
  it('ACCEPTANCE: a suspended project whose child survived is adopted back, same port', async () => {
    // The whole door, closed. Previously: suspend wrote `failed` and erased
    // the identity, so the next spawn had nothing to verify the anchor's
    // occupant against and could only refuse, forever. Now the identity is
    // preserved, the survivor is recognised, and the project is managed again
    // WITHOUT reallocating its address.
    occupant = makeOccupant({ unkillable: true, idleMs: 0 })
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: ANCHOR })
    updateChildState(db, 'p1', {
      status: 'running',
      boundPort: ANCHOR,
      childPid: 4242,
      instanceId: 'iid-survivor',
      lastSeenAt: new Date().toISOString(),
    })

    // Adopt it, then suspend it with a stop that cannot be completed.
    const sup = makeSupervisor(0)
    await sup.tickOnce()
    expect(sup.livePids().get('p1')).toBe(4242)

    const suspending = createMetaSupervisor({
      db,
      brokerEntry: '/fake/dist/cli.js',
      projectDbDir: '/fake/projects',
      intervalMs: 3_600_000,
      childProbe: async () => ({ ok: false, lastRequestAgeMs: null, pid: null }),
      isPortInUse: async (p) => occupant !== null && occupant.alive && occupant.port === p,
      forceStopPid: () => {},
      policy: {
        minFailures: 1,
        cooldownMs: 0,
        maxRestartsPerWindow: 0,
        windowMs: 600_000,
        failedRetryBackoffMs: 0,
      },
    })
    await suspending.tickOnce()
    await suspending.tickOnce()
    const suspended = getProject(db, 'p1')
    expect(suspended?.status).toBe('failed')
    expect(suspended?.instanceId, 'identity must survive an unverified stop').toBe('iid-survivor')

    // The child recovers (the load that wedged it passes) and a later tick
    // finds it on its anchor.
    occupant.answersHealth = true
    const recovering = makeSupervisor(0, 0)
    await recovering.tickOnce()

    expect(spawnedChildren, 'no rival broker was ever started').toHaveLength(0)
    expect(getProject(db, 'p1')).toMatchObject({
      status: 'running',
      boundPort: ANCHOR,
      desiredPort: ANCHOR,
    })
    expect(recovering.livePids().get('p1')).toBe(4242)
  }, 30_000)
})

describe('the shutdown door: a child that outlives stop() stays recoverable', () => {
  it('ACCEPTANCE: a survivor of shutdown is adopted by the NEXT supervisor, same port', async () => {
    // The second half of the same erasure. `stop()` used to null `instance_id`
    // while `updateChildState` left `desired_port` pinned, so a child that
    // outlived its SIGTERM produced a project that was permanently
    // unspawnable AND permanently unadoptable: the anchor was held, and there
    // was no stored identity to recognise the holder by.
    //
    // This matters operationally, not theoretically: restarting the
    // supervisor to cycle children onto a new build runs stop() over every
    // one of them, and the `taskkill ETIMEDOUT` case is logged repeatedly on
    // this machine. The remediation would have caused the damage.
    spawnUnkillable = true
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: ANCHOR })
    const first = makeSupervisor(0)
    await first.tickOnce()
    const spawnedPid = spawnedChildren[0]!.pid
    expect(spawnedPid).toBeGreaterThan(0)

    await first.stop()

    const afterShutdown = getProject(db, 'p1')
    expect(afterShutdown?.status).toBe('registered')
    expect(afterShutdown?.instanceId, 'identity must survive shutdown').not.toBeNull()
    expect(afterShutdown?.boundPort).toBe(ANCHOR)
    expect(afterShutdown?.childPid).toBe(spawnedPid)

    // A new supervisor starts. The survivor is still on the anchor.
    occupant = makeOccupant({
      port: ANCHOR,
      instanceId: afterShutdown!.instanceId!,
      selfReportedPid: spawnedPid,
      realPid: spawnedPid,
      idleMs: 0,
    })
    spawnUnkillable = false
    const second = makeSupervisor(0, 0)
    await second.tickOnce()

    expect(second.livePids().get('p1'), 'the survivor is managed again').toBe(spawnedPid)
    expect(spawnedChildren, 'no rival broker was started').toHaveLength(1)
    expect(getProject(db, 'p1')).toMatchObject({
      status: 'running',
      boundPort: ANCHOR,
      desiredPort: ANCHOR,
    })
  }, 30_000)

  it('a child that DOES exit on shutdown has its identity cleared (complement)', async () => {
    // The honest row either way. When the child really went, the anchor is
    // free and there is nothing to adopt, so carrying a stale identity would
    // only invite a pointless probe.
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: ANCHOR })
    const sup = makeSupervisor(0)
    await sup.tickOnce()
    expect(spawnedChildren).toHaveLength(1)

    await sup.stop()

    expect(getProject(db, 'p1')).toMatchObject({
      status: 'registered',
      boundPort: null,
      childPid: null,
      instanceId: null,
    })
  }, 30_000)
})
describe('adoption and pruning disagree safely, without looping', () => {
  it('a pid that cannot be signalled is adopted at MOST once, not re-adopted every tick', async () => {
    // Adoption is established from a PORT probe; pruning judges the same child
    // by a PID probe. Where they disagree — a pid that does not resolve while
    // the port keeps answering — the pair used to loop at tick rate, and every
    // pass wrote `updateChildState` + `persistDesiredPort` to the registry.
    //
    // The port is still the right signal for ROUTING (a port answering with
    // the right identity is a broker that is genuinely serving), so the row
    // stays `running`; what must not happen is the churn.
    occupant = makeOccupant({ selfReportedPid: 777_777, realPid: 4242, idleMs: 0 })
    seedSurvivedSupervisorRestart()
    const sup = makeSupervisor(0)

    await sup.tickOnce()
    expect(sup.livePids().has('p1'), 'adopted on the strength of the port probe').toBe(true)
    expect(getProject(db, 'p1')?.status).toBe('running')

    await sup.tickOnce() // pid probe says dead -> pruned
    expect(sup.livePids().has('p1')).toBe(false)

    for (let i = 0; i < 4; i++) await sup.tickOnce()
    expect(sup.livePids().has('p1'), 'must NOT re-adopt the same unusable pid').toBe(false)
    // Routing is unaffected: the broker that answers is still the one we point at.
    expect(getProject(db, 'p1')).toMatchObject({ status: 'running', boundPort: ANCHOR })
  }, 30_000)

  it('a DIFFERENT pid on the same port is still adoptable after a prune', async () => {
    // The guard remembers one pid, not the project. A genuinely new process
    // (the child was restarted out of band) must still be adoptable.
    occupant = makeOccupant({ selfReportedPid: 777_777, realPid: 4242, idleMs: 0 })
    seedSurvivedSupervisorRestart()
    const sup = makeSupervisor(0)

    await sup.tickOnce()
    await sup.tickOnce()
    expect(sup.livePids().has('p1')).toBe(false)

    occupant.selfReportedPid = 4242 // now reports a pid that really is alive
    await sup.tickOnce()
    expect(sup.livePids().get('p1')).toBe(4242)
  }, 30_000)
})

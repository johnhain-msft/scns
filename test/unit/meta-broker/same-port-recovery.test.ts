import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { closeSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import {
  createMetaSupervisor,
  type MetaSupervisor,
} from '../../../src/meta-broker/meta-supervisor.js'
import {
  applyMetaSchema,
  getProject,
  registerProject,
  resetProject,
  updateChildState,
} from '../../../src/meta-broker/registry.js'
import type { TickPolicy } from '../../../src/meta-broker/supervisor-tick.js'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  occupied: vi.fn(),
  logFds: new Set<number>(),
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      if (String(args[0]).endsWith('child.log')) mocks.logFds.add(fd)
      return fd
    },
    closeSync: (fd: number) => {
      mocks.logFds.delete(fd)
      fs.closeSync(fd)
    },
  }
})
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}))
vi.mock('../../../src/shared/ports.js', () => ({ isPortInUse: mocks.occupied }))

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  /**
   * Mimics a wedged process: the SIGTERM is delivered (Node sets `killed` the
   * moment the signal is SENT) but the process does not exit. Only SIGKILL
   * lands. This is the exact state `proc.killed` cannot distinguish.
   */
  resistSigterm = false
  constructor(
    readonly pid: number,
    readonly port: number,
    readonly instanceId: string,
  ) {
    super()
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killed = true
    if (this.resistSigterm && signal === 'SIGTERM') return true
    this.signalCode = signal
    this.emit('exit', null, signal)
    return true
  }
}

describe('automatic child recovery preserves session-pinned ports (no real processes or HTTP)', () => {
  let db: Database.Database
  let home: string
  let supervisor: MetaSupervisor
  let children: FakeChild[]
  let failedInstance: string | undefined
  let refuseStop: boolean
  let spawnFails: boolean

  beforeEach(() => {
    vi.useFakeTimers()
    db = new Database(':memory:')
    applyMetaSchema(db)
    home = mkdtempSync(join(tmpdir(), 'scns-same-port-'))
    children = []
    failedInstance = undefined
    refuseStop = false
    spawnFails = false
    mocks.occupied.mockReset().mockResolvedValue(false)
    mocks.spawn.mockReset().mockImplementation((_command, args, options) => {
      if (spawnFails) throw new Error('spawn refused by the OS')
      const child = new FakeChild(
        900_000_000 + children.length,
        Number(args[args.indexOf('--port') + 1]),
        options.env.SCNS_INSTANCE_ID,
      )
      children.push(child)
      return child
    })
    const signal = (pid: number, sig: number | NodeJS.Signals) => {
      const child = children.find((c) => c.pid === pid && c.signalCode === null)
      if (!child) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      if (sig !== 0) {
        if (refuseStop) throw Object.assign(new Error('denied'), { code: 'EPERM' })
        child.kill(sig as NodeJS.Signals)
      }
      return true
    }
    vi.spyOn(process, 'kill').mockImplementation(signal)
    mocks.spawnSync.mockReset().mockImplementation((command, args) => {
      const pid = Number(command === 'taskkill' ? args[args.indexOf('/PID') + 1] : args.at(-1))
      try {
        signal(pid, 'SIGTERM')
        return { status: 0, stderr: '' }
      } catch (error) {
        return { status: 1, stderr: String(error) }
      }
    })
    // The pre-fix blue/green path performs admin POSTs: those MUST be mocked
    // even in the RED run, because the real machine has listeners in this pool.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"activeRequestCount":0}', { status: 200 })),
    )
    registerProject(db, { projectId: 'a', projectRoot: process.cwd(), desiredPort: 3500 })
    supervisor = makeSupervisor()
  })

  function makeSupervisor(policy?: Partial<TickPolicy>): MetaSupervisor {
    return createMetaSupervisor({
      db,
      brokerEntry: 'dist/cli.js',
      projectDbDir: home,
      policy: {
        minFailures: 1,
        cooldownMs: 0,
        maxRestartsPerWindow: 5,
        windowMs: 60_000,
        ...policy,
      },
      httpProbe: async (_port, instanceId) => instanceId !== failedInstance,
    })
  }

  afterEach(async () => {
    const stopped = supervisor.stop()
    await vi.runAllTimersAsync()
    await stopped
    db.close()
    for (const fd of mocks.logFds) closeSync(fd)
    rmSync(home, { recursive: true, force: true })
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function initialChild() {
    await supervisor.tickOnce()
    await supervisor.tickOnce()
    expect(getProject(db, 'a')?.status).toBe('running')
    return children[0]!
  }

  async function recover(child: FakeChild) {
    failedInstance = child.instanceId
    await supervisor.tickOnce()
    const recovery = supervisor.tickOnce()
    await vi.runAllTimersAsync()
    await recovery
  }

  /**
   * One tick with the fake clock pumped. `recover` assumes its first tick is a
   * probe, which only holds while `health_failures` is 0; once a project is
   * already `failing`, every tick plans a restart and the restarter's
   * stop-grace sleeps need the timers advanced or the await never settles.
   */
  async function pumpedTick() {
    const tick = supervisor.tickOnce()
    await vi.runAllTimersAsync()
    await tick
  }

  it('stops the old process before restarting on exactly its existing port', async () => {
    const old = await initialChild()
    await recover(old)
    expect(children.map((c) => c.port)).toEqual([3500, 3500])
    expect(old.signalCode).not.toBeNull()
    expect(children[1]!.instanceId).not.toBe(old.instanceId)
    await supervisor.tickOnce()
    expect(getProject(db, 'a')).toMatchObject({
      status: 'running',
      boundPort: 3500,
      desiredPort: 3500,
    })
  })

  it('falls back to a fresh port when the old process cannot be stopped', async () => {
    // Regression (2026-10-12). Same-port recovery must kill the old child
    // before it can rebind the pinned port, so it refuses when the stop does
    // not demonstrably succeed. Refusing was correct; refusing as a DEAD END
    // was not — on a loaded machine `taskkill` times out, three refusals
    // exhaust the restart budget, and the child is suspended having never been
    // restarted. Blue/green needs nothing to die first, so it is the fallback.
    const old = await initialChild()
    refuseStop = true
    await recover(old)
    expect(children).toHaveLength(2)
    expect(children[1]!.port).not.toBe(3500)
    expect(old.signalCode).toBeNull()
    expect(getProject(db, 'a')).toMatchObject({
      status: 'running',
      boundPort: children[1]!.port,
      // The pinned address is kept as the anchor: the next clean restart goes
      // home to 3500 once the stuck process is gone.
      desiredPort: 3500,
    })
  })

  it('recovers on another port when the stopped process leaves the anchor occupied', async () => {
    const old = await initialChild()
    mocks.occupied.mockImplementation(async (port: number) => port === 3500)
    await recover(old)
    expect(children).toHaveLength(2)
    expect(children[1]!.port).not.toBe(3500)
    expect(getProject(db, 'a')).toMatchObject({ desiredPort: 3500, boundPort: children[1]!.port })
  })

  it('suspends — into the retry backoff — when recovery fails on both ports', async () => {
    // A bare same-port refusal costs no slot (it falls through to the
    // blue/green fallback), but the fallback attempt itself is charged whether
    // or not its green verifies: it spawns a real process in the normal case,
    // and an uncharged failure would retry the full-cost path — taskkill
    // timeout, green spawn, health wait — every cooldown forever, holding the
    // serial tick loop and starving every other project's probes. Suspension
    // is no longer a dead end (the failed-retry backoff re-spawns it), so the
    // circuit-breaker is safe to trip.
    supervisor = makeSupervisor({ maxRestartsPerWindow: 2, windowMs: 600_000 })
    const old = await initialChild()
    refuseStop = true
    spawnFails = true
    failedInstance = old.instanceId
    // Tick 1 is the failing probe; ticks 2-3 are two both-paths-failed
    // recovery attempts (budget 2); tick 4 suspends; ticks 5-6 sit quietly
    // inside the failed-retry backoff.
    for (let tick = 0; tick < 6; tick++) await pumpedTick()
    expect(children).toHaveLength(1)
    expect(getProject(db, 'a')?.status).toBe('failed')
  })

  it('grants a reset project a fresh restart budget', async () => {
    // `scns meta reset` runs in a separate process and can only write the
    // registry — it cannot touch the supervisor's in-memory restartHistory. If
    // the planned spawn did not clear that history, a reset project would
    // inherit the spent budget and re-suspend on its FIRST failure streak,
    // with zero new restarts: the reset would silently do nothing.
    supervisor = makeSupervisor({ maxRestartsPerWindow: 2, windowMs: 600_000 })
    const old = await initialChild()
    refuseStop = true
    spawnFails = true
    failedInstance = old.instanceId
    for (let tick = 0; tick < 4; tick++) await pumpedTick()
    expect(getProject(db, 'a')?.status).toBe('failed')

    // Operator resets; the machine stall is over.
    resetProject(db, 'a')
    refuseStop = false
    spawnFails = false
    failedInstance = undefined
    await pumpedTick() // spawn (clears the stale in-memory budget)
    await pumpedTick() // probe → running
    expect(getProject(db, 'a')?.status).toBe('running')

    // A fresh failure streak must get fresh restarts, not an instant suspend
    // from the pre-reset charges.
    failedInstance = children.at(-1)!.instanceId
    await pumpedTick() // failing probe
    await pumpedTick() // restart — would be 'suspend' with the stale budget
    expect(getProject(db, 'a')?.status).not.toBe('failed')
    expect(children.length).toBeGreaterThan(2)
  })

  it('SIGKILLs a suspended child that ignored SIGTERM — no zombie squatting the anchor', async () => {
    // suspendChild used to fire one unverified SIGTERM. A child that shrugged
    // it off kept the project's data.db open and squatted the desired_port
    // anchor, so every failed-retry spawn refused on port occupancy until the
    // zombie happened to die.
    supervisor = makeSupervisor({ maxRestartsPerWindow: 2, windowMs: 600_000 })
    const old = await initialChild()
    old.resistSigterm = true
    refuseStop = true
    spawnFails = true
    failedInstance = old.instanceId
    for (let tick = 0; tick < 4; tick++) await pumpedTick()
    expect(getProject(db, 'a')?.status).toBe('failed')
    expect(old.signalCode).toBe('SIGKILL')
  })

  it('stop() SIGKILLs a child that ignored SIGTERM instead of leaking it', async () => {
    // The old escalation gated on `proc.killed`, which Node sets when a signal
    // is SENT — true the instant the SIGTERM goes out, whether or not the
    // process exits. The SIGKILL branch was dead code, and a SIGTERM-resistant
    // child leaked on every supervisor shutdown.
    const old = await initialChild()
    old.resistSigterm = true
    const stopping = supervisor.stop()
    await vi.runAllTimersAsync()
    await stopping
    expect(old.signalCode).toBe('SIGKILL')
  })

  it('still suspends a child that really is crash-looping', async () => {
    // The budget must keep working for the case it exists for: every attempt
    // here genuinely starts a process, so every attempt genuinely costs a slot.
    const old = await initialChild()
    let current = old
    for (let attempt = 0; attempt < 6; attempt++) {
      await recover(current)
      current = children.at(-1)!
    }
    expect(getProject(db, 'a')?.status).toBe('failed')
  })

  it('never silently reallocates an occupied anchor on a cold start', async () => {
    mocks.occupied.mockImplementation(async (port: number) => port === 3500)
    await supervisor.tickOnce()
    expect(children).toHaveLength(0)
    expect(getProject(db, 'a')?.desiredPort).toBe(3500)
  })

  it('reserves another project anchor even while that project has no listener', async () => {
    updateChildState(db, 'a', {
      status: 'failed',
      boundPort: null,
      childPid: null,
      instanceId: null,
      // Inside the suspension backoff, so 'a' is not respawned this tick and
      // the assertion stays about anchor reservation.
      lastSeenAt: new Date().toISOString(),
    })
    registerProject(db, { projectId: 'b', projectRoot: join(home, 'b') })
    await supervisor.tickOnce()
    expect(children.map((c) => c.port)).toEqual([3501])
  })
})

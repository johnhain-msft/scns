/**
 * ACCEPTANCE — idle reaping must never cost a session its project broker.
 *
 * The failure this guards against is the worst one available here. The Copilot
 * extension only retries a `/api/meta/resolve` refusal whose reason is in an
 * allow-list; anything else makes it fall back to `global:fallback`, and a
 * session on `global:fallback` silently REFUSES every memory write for the
 * rest of its life. So "reap idle brokers" is only safe if a session arriving
 * at a reaped project waits for the wake instead of latching fallback.
 *
 * This test executes the REAL `resolveBrokerRoute` sliced out of the generated
 * extension source — not a re-implementation of it — against the REAL
 * `/api/meta/resolve` route and a REAL registry DB, with a stand-in supervisor
 * respawning the child. If either the extension's retryable list or the
 * route's reason changes, this fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import {
  applyMetaSchema,
  getProject,
  registerProject,
  updateChildState,
  type StoppedReason,
} from '../../../../src/meta-broker/registry.js'
import {
  createMetaSupervisor,
  type MetaSupervisor,
} from '../../../../src/meta-broker/meta-supervisor.js'
import {
  generateExtensionSource,
  CHILD_WAKE_TIMEOUT_MS,
} from '../../../../src/copilot-extension/extension-template.js'

const PROJECT_ID = 'idle-reap-acceptance'

interface RouteHarness {
  resolveBrokerRoute(trigger: string): Promise<void>
  label(): string
  projectId(): string | null
  brokerUrl(): string
  log(): string[]
}

/**
 * Slice the shipped broker-resolution block out of the generated extension and
 * make it callable. Anchored on source the template actually emits, so a
 * refactor that moves this logic fails loudly here rather than silently
 * testing nothing.
 */
function buildRouteHarness(brokerUrl: string): RouteHarness {
  const source = generateExtensionSource({ brokerUrl })
  const start = source.indexOf('let effectiveBrokerUrl = SCNS_BROKER_URL || BROKER_URL;')
  const end = source.indexOf('// Gate every broker call on the startup resolve')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('extension template no longer contains the broker-resolution block')
  }
  const block = source.slice(start, end)
  if (!block.includes('async function resolveBrokerRoute(')) {
    throw new Error('sliced block does not contain resolveBrokerRoute')
  }

  const factory = new Function(
    'BROKER_URL',
    'SCNS_BROKER_URL',
    'TIMEOUT_MS',
    'IS_TEAM_MODE',
    'announceOnce',
    'authHeaders',
    `${block}
     return {
       resolveBrokerRoute,
       label: () => brokerRouteLabel,
       projectId: () => resolvedProjectId,
       brokerUrl: () => effectiveBrokerUrl,
       log: () => brokerResolutionLog.slice(),
     };`,
  ) as (
    brokerUrl: string,
    scnsBrokerUrl: string | null,
    timeoutMs: number,
    isTeamMode: boolean,
    announceOnce: () => Promise<void>,
    authHeaders: () => Record<string, string>,
  ) => RouteHarness

  return factory(
    brokerUrl,
    null,
    5_000,
    false,
    async () => {},
    () => ({}),
  )
}

/**
 * Run the shipped `resolveBrokerRoute` on a VIRTUAL clock.
 *
 * `Date` and `setTimeout` are injected into the sliced block, shadowing the
 * globals, so the retry loop's own deadline arithmetic runs for real while no
 * wall time passes. A hard pass limit converts the failure mode under test —
 * a loop that never terminates — into a thrown error instead of a hung suite.
 */
async function runOnVirtualClock(
  brokerUrl: string,
  maxPasses = 10_000,
): Promise<{ harness: RouteHarness; elapsedMs: number; passes: number }> {
  const source = generateExtensionSource({ brokerUrl })
  const start = source.indexOf('let effectiveBrokerUrl = SCNS_BROKER_URL || BROKER_URL;')
  const end = source.indexOf('// Gate every broker call on the startup resolve')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('extension template no longer contains the broker-resolution block')
  }
  const block = source.slice(start, end)

  const t0 = 1_700_000_000_000
  let nowMs = t0
  let passes = 0
  const fakeDate = { now: () => nowMs }
  const fakeSetTimeout = (fn: () => void, ms: number): number => {
    passes += 1
    if (passes > maxPasses) {
      throw new Error(
        `UNBOUNDED: the startup resolve was still retrying after ${passes} passes ` +
          `(virtual elapsed ${nowMs - t0}ms). It must terminate within the wake budget.`,
      )
    }
    nowMs += Math.max(0, ms)
    queueMicrotask(fn)
    return 0
  }

  const factory = new Function(
    'BROKER_URL',
    'SCNS_BROKER_URL',
    'TIMEOUT_MS',
    'IS_TEAM_MODE',
    'announceOnce',
    'authHeaders',
    'Date',
    'setTimeout',
    `${block}
     return {
       resolveBrokerRoute,
       label: () => brokerRouteLabel,
       projectId: () => resolvedProjectId,
       brokerUrl: () => effectiveBrokerUrl,
       log: () => brokerResolutionLog.slice(),
     };`,
  ) as (
    brokerUrl: string,
    scnsBrokerUrl: string | null,
    timeoutMs: number,
    isTeamMode: boolean,
    announceOnce: () => Promise<void>,
    authHeaders: () => Record<string, string>,
    dateImpl: { now: () => number },
    setTimeoutImpl: (fn: () => void, ms: number) => number,
  ) => RouteHarness

  const harness = factory(
    brokerUrl,
    null,
    5_000,
    false,
    async () => {},
    () => ({}),
    fakeDate,
    fakeSetTimeout,
  )
  await harness.resolveBrokerRoute('startup')
  return { harness, elapsedMs: nowMs - t0, passes }
}

/**
 * Stand-in meta-supervisor — the REAL one, with fake child processes.
 *
 * An earlier revision of this test collapsed `registered -> running` into a
 * single DB write 100ms later. That shortcut assumed away the thing most
 * likely to break: the real path cannot do it in one step. The supervisor
 * needs one tick to notice `registered` and spawn (which writes `starting`,
 * not `running`), and a SECOND tick to probe and promote `starting -> running`.
 * Measured on this machine at the production 5s tick, that costs 10.07–15.19s.
 *
 * So this uses the real `createMetaSupervisor` and the real two-tick
 * transition, with the interval compressed and the child's boot faked, so the
 * STATE MACHINE is exercised honestly while the wall clock is not.
 */
const SPAWNED: FakeChild[] = []
let nextPid = 7000
/** Fake child boot time: probes fail until this has elapsed since spawn. */
const FAKE_BOOT_MS = 120
const spawnedAt = new Map<number, number>()

class FakeChild extends EventEmitter {
  public killed = false
  public exitCode: number | null = null
  public signalCode: NodeJS.Signals | null = null
  constructor(public readonly pid: number) {
    super()
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true
    this.signalCode = signal ?? 'SIGTERM'
    setImmediate(() => this.emit('exit', null, signal ?? 'SIGTERM'))
    return true
  }
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (): ChildProcess => {
      const child = new FakeChild(nextPid++)
      SPAWNED.push(child)
      spawnedAt.set(child.pid, Date.now())
      return child as unknown as ChildProcess
    },
  }
})

let db: Database.Database
let broker: BrokerServer
let server: Server
let tempDir: string
let metaDbPath: string
let baseUrl: string
let supervisor: MetaSupervisor | null = null
/** The supervisor's own registry handle, so cleanup can close it (Windows EBUSY). */
let supervisorMeta: Database.Database | null = null

function openMeta(): Database.Database {
  const meta = new Database(metaDbPath)
  applyMetaSchema(meta)
  return meta
}

/** Put the project into `stopped` with the given reason. */
function seedStopped(reason: StoppedReason | null): void {
  const meta = openMeta()
  // The project root is this process's cwd so the extension's
  // `process.cwd()` resolves to it, exactly as a real session would.
  registerProject(meta, { projectId: PROJECT_ID, projectRoot: process.cwd() })
  updateChildState(meta, PROJECT_ID, {
    status: 'stopped',
    stoppedReason: reason,
    boundPort: null,
    childPid: null,
    instanceId: null,
    lastSeenAt: new Date().toISOString(),
  })
  meta.close()
}

/**
 * Start the REAL supervisor against the temp registry. It will go
 * `registered -> starting -> running` over two genuine ticks, exactly as
 * production does.
 */
function startRealSupervisor(boundPort: number, intervalMs = 120): void {
  const meta = openMeta()
  supervisorMeta = meta
  supervisor = createMetaSupervisor({
    db: meta,
    brokerEntry: '/fake/dist/cli.js',
    projectDbDir: tempDir,
    intervalMs,
    // The child answers only once its fake boot has elapsed, so the first
    // probe after a spawn fails just as a real one does.
    childProbe: async (port) => {
      const pid = [...spawnedAt.keys()].at(-1)
      const started = pid === undefined ? 0 : (spawnedAt.get(pid) ?? 0)
      const booted = Date.now() - started >= FAKE_BOOT_MS
      return { ok: booted && port === boundPort, lastRequestAgeMs: booted ? 0 : null }
    },
    isPortInUse: async () => false,
    forceStopPid: () => {},
    policy: {
      minFailures: 1000,
      cooldownMs: 600_000,
      maxRestartsPerWindow: 1000,
      windowMs: 600_000,
      idleTimeoutMs: 0,
    },
  })
  // The woken row must spawn onto the port the test expects.
  updateChildState(meta, PROJECT_ID, {
    status: getProject(meta, PROJECT_ID)!.status,
    boundPort: null,
    childPid: null,
    instanceId: null,
    lastSeenAt: new Date().toISOString(),
    stoppedReason: getProject(meta, PROJECT_ID)!.stoppedReason,
  })
  meta
    .prepare('UPDATE projects SET desired_port = ? WHERE project_id = ?')
    .run(boundPort, PROJECT_ID)
  supervisor.start()
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'scns-idle-wake-'))
  metaDbPath = join(tempDir, 'meta-broker.db')
  SPAWNED.length = 0
  spawnedAt.clear()
  nextPid = 7000
  supervisor = null
  supervisorMeta = null
  db = openDatabase(':memory:')
  broker = createBrokerServer(db, createEventLog(db), undefined, undefined, {
    metaRegistryDbPath: metaDbPath,
  })
  server = createServer(broker.app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterEach(async () => {
  if (supervisor) await supervisor.stop()
  supervisor = null
  try {
    supervisorMeta?.close()
  } catch {
    /* already closed */
  }
  supervisorMeta = null
  await broker.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  closeDatabase(db)
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // Windows can still hold the SQLite file briefly; a leaked temp dir is
    // not worth failing an otherwise-passing test over.
  }
})

describe('ACCEPTANCE: a session starting against an idle-reaped broker', () => {
  it('lands on project:<id> and NEVER on global:fallback', async () => {
    seedStopped('idle')
    startRealSupervisor(31999)

    const harness = buildRouteHarness(baseUrl)
    await harness.resolveBrokerRoute('startup')

    expect(harness.label()).toBe(`project:${PROJECT_ID}`)
    expect(harness.label()).not.toBe('global:fallback')
    expect(harness.brokerUrl()).toBe('http://127.0.0.1:31999')
    expect(harness.projectId()).toBe(PROJECT_ID)
    // It must have gone through the idle path, not simply found it running.
    expect(harness.log().join('\n')).toContain('child-idle')
    // And through the REAL two-step transition, not a shortcut: the row is
    // only `running` because a spawn wrote `starting` and a later probe
    // promoted it.
    expect(SPAWNED.length, 'a child was really spawned by the supervisor').toBeGreaterThan(0)
  }, 30_000)

  it('passes through `starting` on the way to `running` (real tick granularity)', async () => {
    // Pins the shape the budget has to cover. If someone ever makes a wake
    // promote straight to `running`, this fails and the budget can be
    // revisited deliberately rather than by accident.
    //
    // Ticks are driven MANUALLY rather than by `start()`. An earlier revision
    // polled the registry every 10ms while the supervisor ran on a 120ms
    // interval, so the `starting` window was a ~120ms target sampled by a
    // racing loop — it passed in isolation and failed roughly 1 run in 3 under
    // parallel workers. The construction was right and only the OBSERVATION
    // was weak; stepping the supervisor one tick at a time makes the same
    // state machine deterministic.
    seedStopped('idle')
    const meta = openMeta()
    supervisorMeta = meta
    meta.prepare('UPDATE projects SET desired_port = ? WHERE project_id = ?').run(31998, PROJECT_ID)

    let booted = false
    supervisor = createMetaSupervisor({
      db: meta,
      brokerEntry: '/fake/dist/cli.js',
      projectDbDir: tempDir,
      intervalMs: 3_600_000, // never self-ticks; this test steps it by hand
      childProbe: async () => ({ ok: booted, lastRequestAgeMs: booted ? 0 : null }),
      isPortInUse: async () => false,
      forceStopPid: () => {},
      policy: {
        minFailures: 1000,
        cooldownMs: 600_000,
        maxRestartsPerWindow: 1000,
        windowMs: 600_000,
        idleTimeoutMs: 0,
      },
    })

    const statusNow = (): string | undefined => getProject(meta, PROJECT_ID)?.status
    expect(statusNow()).toBe('stopped')

    // The wake, exactly as `/api/meta/resolve` performs it.
    await fetch(`${baseUrl}/api/meta/resolve?path=${encodeURIComponent(process.cwd())}`)
    expect(statusNow()).toBe('registered')

    // Tick 1 spawns. It writes `starting` — NOT `running`.
    await supervisor.tickOnce()
    expect(statusNow(), 'one tick can only reach starting').toBe('starting')
    expect(SPAWNED.length).toBe(1)

    // A probe before the child is up does not promote it either.
    await supervisor.tickOnce()
    expect(statusNow(), 'a failed probe must not promote a starting child').toBe('starting')

    // Only once the child answers does a SECOND tick promote it.
    booted = true
    await supervisor.tickOnce()
    expect(statusNow()).toBe('running')
  }, 30_000)

  it('the wake budget is set from the measured two-tick latency, with margin', () => {
    // Measured on this machine over 5 real child spawns at the production 5s
    // tick: 10.07s, 10.07s, 10.18s, 15.19s, 10.26s (mean 11.16s, max 15.19s).
    // The latency is quantised to the tick, so the realistic tail is a 4-tick
    // 20s, not the mean. The generic 20s readiness budget left ~4.8s against
    // the worst OBSERVED case and nothing against the tail.
    const MEASURED_MAX_MS = 15_190
    const FOUR_TICK_TAIL_MS = 20_000
    expect(CHILD_WAKE_TIMEOUT_MS).toBeGreaterThan(MEASURED_MAX_MS * 2)
    expect(CHILD_WAKE_TIMEOUT_MS).toBeGreaterThan(FOUR_TICK_TAIL_MS * 2)
  })

  it('REGRESSION: a persistent child-idle answer is BOUNDED, it does not wait forever', async () => {
    // The bug this guards. The wake extension sampled `Date.now()` inside the
    // retry loop, so every pass produced a deadline later than the last and
    // the budget advanced 45s PER PASS, forever. The invariant that had been
    // checked — "extended only forward, never shortens an in-flight wait" —
    // was true and was the wrong property; nobody checked it could not extend
    // without bound.
    //
    // It is an S1 rather than a nuisance because the startup resolution gates
    // every broker call in the session (fetchBroker -> recoverProjectRoute ->
    // awaitStartupResolution), so an unbounded one hangs every SCNS tool call
    // for the life of the session.
    //
    // Driven on a VIRTUAL clock — real `Date` and `setTimeout` injected into
    // the sliced block — so this asserts termination exactly and instantly,
    // using the real shipped CHILD_WAKE_TIMEOUT_MS rather than a scaled copy.
    const stub = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          resolved: false,
          reason: 'child-idle',
          projectId: PROJECT_ID,
          status: 'stopped',
          waking: false,
        }),
      )
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
    const stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`

    try {
      const { harness, elapsedMs, passes } = await runOnVirtualClock(stubUrl)
      // Bounded: it terminated at all, and within the documented budget.
      expect(elapsedMs).toBeLessThanOrEqual(CHILD_WAKE_TIMEOUT_MS + 5_000)
      expect(passes).toBeGreaterThan(1)
      // And it gave up honestly rather than pretending to have resolved.
      expect(harness.label()).toBe('global:fallback')
    } finally {
      await new Promise<void>((r) => stub.close(() => r()))
    }
  }, 30_000)

  it('the resolve itself requests the wake, so the supervisor can act on it', async () => {
    seedStopped('idle')
    const res = await fetch(`${baseUrl}/api/meta/resolve?path=${encodeURIComponent(process.cwd())}`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      resolved: false,
      reason: 'child-idle',
      projectId: PROJECT_ID,
      waking: true,
    })

    const meta = openMeta()
    expect(getProject(meta, PROJECT_ID)).toMatchObject({
      status: 'registered',
      stoppedReason: null,
    })
    meta.close()
  })

  it('NEGATIVE CONTROL: an operator stop stays terminal and does latch fallback', async () => {
    // Proof that the distinction is real: the same machinery, with
    // `stopped_reason` = operator, is NOT woken and is NOT retried — which is
    // correct, because a human meant it, and is exactly why `child-stopped`
    // must stay out of the extension's retryable list.
    seedStopped('operator')

    const harness = buildRouteHarness(baseUrl)
    await harness.resolveBrokerRoute('startup')

    expect(harness.label()).toBe('global:fallback')
    expect(harness.log().join('\n')).toContain('child-stopped')

    const meta = openMeta()
    expect(getProject(meta, PROJECT_ID)?.status).toBe('stopped')
    meta.close()
  }, 30_000)

  it('NEGATIVE CONTROL: an unexplained stop is not woken either', async () => {
    seedStopped(null)
    const res = await fetch(`${baseUrl}/api/meta/resolve?path=${encodeURIComponent(process.cwd())}`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ resolved: false, reason: 'child-stopped' })

    const meta = openMeta()
    expect(getProject(meta, PROJECT_ID)?.status).toBe('stopped')
    meta.close()
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'

// ── Mocks (before imports) ────────────────────────────────────

vi.mock('../../../src/shared/logger.js', () => {
  const mockChild = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  mockChild.child.mockReturnValue(mockChild)
  return {
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnValue(mockChild),
    },
  }
})

// #61 — the broker records its pid so an external supervisor can stop a HUNG
// process. Mocked here so this unit test never touches the real ~/.scns/run/,
// and so the write/remove can be asserted directly.
const pidfileCalls = {
  written: [] as Array<{ path: string; pid: number }>,
  removed: [] as string[],
}
vi.mock('../../../src/broker/services/broker-pidfile.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/broker/services/broker-pidfile.js')>()
  return {
    ...actual,
    writeBrokerPidfile: vi.fn((path: string, record: { pid: number }) => {
      pidfileCalls.written.push({ path, pid: record.pid })
    }),
    removeBrokerPidfile: vi.fn((path: string) => {
      pidfileCalls.removed.push(path)
    }),
  }
})

const mockDb = {
  close: vi.fn(),
  pragma: vi.fn().mockReturnValue([{ integrity_check: 'ok' }]),
  prepare: vi.fn().mockReturnValue({ get: vi.fn(), run: vi.fn(), all: vi.fn() }),
  // WS-0 — startBroker now constructs the Safety Kernel, whose
  // ensureKernelAuditTable() issues a CREATE TABLE via db.exec().
  exec: vi.fn(),
}

vi.mock('../../../src/broker/config.js', () => ({
  loadConfig: vi.fn(() => ({
    port: 0,
    bind: '127.0.0.1',
    dbPath: ':memory:',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 20_000,
    zombieGraceMs: 300_000,
    brokerToken: null,
    autoRespawn: true,
    maxRespawnRetries: 3,
    respawnBackoffBaseMs: 5000,
    autoScaleIntervalMs: 30_000,
    autoScaleEnabled: false,
    teamReaperEnabled: false,
    teamReaperIntervalMs: 60_000,
    teamReaperGraceMs: 300_000,
    autospawn: {
      enabled: false,
      intervalMs: 30_000,
      cooldownMs: 300_000,
    },
    qualityGate: {
      baselineLintEnabled: true,
      baselineTestsEnabled: true,
    },
  })),
  ensureDbDirectory: vi.fn(),
}))

vi.mock('../../../src/broker/storage/db.js', () => ({
  openDatabase: vi.fn(() => mockDb),
  closeDatabase: vi.fn(),
}))

const mockDispatcher = {
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}

vi.mock('../../../src/broker/event-dispatcher.js', () => ({
  createEventDispatcher: vi.fn(() => mockDispatcher),
}))

const mockEventLog = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    if (typeof prop === 'string') {
      if (!_target[prop]) {
        _target[prop] = vi.fn(() => ({
          id: 1,
          event_type: prop,
          session_id: null,
          payload: '{}',
          created_at: new Date().toISOString(),
        }))
      }
      return _target[prop]
    }
    return undefined
  },
})

vi.mock('../../../src/broker/services/event-log.js', () => ({
  createEventLog: vi.fn(() => mockEventLog),
}))

vi.mock('../../../src/broker/startup-cleanup.js', () => ({
  cleanupStaleSessionsOnStartup: vi.fn(),
}))

vi.mock('../../../src/broker/storage/repositories/scheduler-repository.js', () => ({
  seedDefaultTasks: vi.fn(),
}))

const mockHeartbeatPoller = { stop: vi.fn() }

vi.mock('../../../src/broker/heartbeat-poller.js', () => ({
  startHeartbeatPoller: vi.fn(() => mockHeartbeatPoller),
}))

const mockAgentSpawner = {
  spawn: vi.fn(),
  getActiveAgents: vi.fn(() => new Map()),
  cleanup: vi.fn(),
  shutdownAll: vi.fn(),
}

vi.mock('../../../src/broker/services/agent-spawner.js', () => ({
  createAgentSpawner: vi.fn(() => mockAgentSpawner),
}))

vi.mock('../../../src/broker/services/session-recovery.js', () => ({
  loadPendingSnapshots: vi.fn(() => []),
  recoverAgents: vi.fn(async () => []),
  expireOldSnapshots: vi.fn(() => 0),
  expireOldSnapshotsHours: vi.fn(() => 0),
  snapshotActiveAgents: vi.fn(),
  recordBrokerStartup: vi.fn(() => null),
  crashLoopDetectedOnStartup: vi.fn(() => false),
  clearRecoveryHardDisable: vi.fn(),
  RECOVERY_SNAPSHOT_MAX_AGE_HOURS: 1,
  CRASH_LOOP_MIN_DELTA_MS: 60_000,
}))

vi.mock('../../../src/broker/services/health-watchdog.js', () => ({
  createHealthWatchdog: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    check: vi.fn(() => ({ healthy: true, failures: [] })),
  })),
}))

const mockRateMonitor = {
  recordRequest: vi.fn(),
  canProceed: vi.fn(() => ({ allowed: true })),
  getRecommendation: vi.fn(() => 'normal'),
  getStats: vi.fn(() => ({})),
  getBackoffDelay: vi.fn(() => 0),
  recordExternalLimit: vi.fn(),
  shouldYieldToUser: vi.fn(() => false),
  reset: vi.fn(),
}

vi.mock('../../../src/rate-limit/rate-monitor.js', () => ({
  createRateMonitor: vi.fn(() => mockRateMonitor),
}))

const mockOrchestrator = {
  registerAgent: vi.fn(),
  unregisterAgent: vi.fn(),
  getAgentCard: vi.fn(),
  findAgentsByCapability: vi.fn(() => []),
  getWellKnownJson: vi.fn(() => ({ agents: [] })),
  submitTask: vi.fn(),
  assignTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  getTask: vi.fn(),
  listTasks: vi.fn(() => []),
  createTeamFromTemplate: vi.fn(),
  createTeamFromManifest: vi.fn(),
  advancePhase: vi.fn(),
  getOrchestrationState: vi.fn(),
  reconcile: vi.fn(() => []),
  getScalerStatus: vi.fn(() => ({})),
  getRespawnStats: vi.fn(() => ({})),
  tickAutoScaler: vi.fn(async () => ({ action: 'hold', count: 0, reason: 'test' })),
  respawnDeadAgent: vi.fn(async () => ({
    originalId: '',
    newId: null,
    success: false,
    attempt: 0,
  })),
  handleJsonRpc: vi.fn(),
  getStatus: vi.fn(() => ({})),
}

vi.mock('../../../src/broker/a2a/team-orchestrator.js', () => ({
  createTeamOrchestrator: vi.fn(() => mockOrchestrator),
}))

const mockScheduler = {
  start: vi.fn(),
  stop: vi.fn(),
  tick: vi.fn(async () => {}),
  registerHandler: vi.fn(),
  isRunning: vi.fn(() => true),
  setLastTickTime: vi.fn(),
}

vi.mock('../../../src/broker/services/task-scheduler.js', () => ({
  createTaskScheduler: vi.fn(() => mockScheduler),
}))

// Mock listen-retry to pass through without retry delays (keeps tests fast)
vi.mock('../../../src/broker/listen-retry.js', () => ({
  listenWithRetry: vi.fn(async (listenFn: (port: number) => any, port: number) => {
    return new Promise((resolve, reject) => {
      const srv = listenFn(port)
      srv.on('error', (err: Error) => {
        srv.close?.()
        reject(err)
      })
      srv.on('listening', () => resolve(srv))
    })
  }),
  // Phase 1: dual-mode listen helpers. Default parseListenFd → null so the
  // mocked startup keeps taking the port path (listenWithRetry) as before.
  parseListenFd: vi.fn(() => null),
  listenOnFd: vi.fn(async (listenFn: (handle: { fd: number }) => any, fd: number) => {
    return new Promise((resolve, reject) => {
      const srv = listenFn({ fd })
      srv.on('error', (err: Error) => {
        srv.close?.()
        reject(err)
      })
      srv.on('listening', () => resolve(srv))
    })
  }),
}))

// Build a fake BrokerServer whose .app.listen() creates a real HTTP server on port 0
function createFakeBrokerServer() {
  const transports = new Map()
  const closeFn = vi.fn(async () => {
    transports.clear()
  })

  const app: any = Object.assign(
    (_req: any, res: any) => {
      res.writeHead(200)
      res.end('ok')
    },
    {
      listen(port: number, host?: string) {
        const srv = createServer(app)
        // Mirror express: listen(port[, host]) — the WI-2a bind tests assert
        // the host actually reaches the underlying server.
        if (host !== undefined) srv.listen(port, host)
        else srv.listen(port)
        return srv
      },
    },
  )

  return { app, transports, close: closeFn }
}

let fakeBrokerServer: ReturnType<typeof createFakeBrokerServer>

vi.mock('../../../src/broker/server.js', () => ({
  createBrokerServer: vi.fn((..._args: unknown[]) => fakeBrokerServer),
}))

// Mock ShutdownManager — track registered labels + capture shutdown behaviour
const registeredCleanups: Array<{ label: string; fn: () => Promise<void> }> = []
const mockShutdownInstance = {
  register: vi.fn((label: string, fn: () => Promise<void>) => {
    registeredCleanups.push({ label, fn })
  }),
  shutdown: vi.fn(async () => {
    for (const _body of registeredCleanups) {
      await _body.fn()
    }
  }),
  get shuttingDown() {
    return false
  },
}

vi.mock('../../../src/broker/shutdown.js', () => ({
  ShutdownManager: vi.fn(() => mockShutdownInstance),
}))

// ── Imports (after mocks) ────────────────────────────────────

import { startBroker, type BrokerHandle } from '../../../src/broker/startup.js'
import { loadConfig, ensureDbDirectory } from '../../../src/broker/config.js'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../src/broker/event-dispatcher.js'
import { cleanupStaleSessionsOnStartup } from '../../../src/broker/startup-cleanup.js'
import { startHeartbeatPoller } from '../../../src/broker/heartbeat-poller.js'
import { createBrokerServer } from '../../../src/broker/server.js'
import { createTaskScheduler } from '../../../src/broker/services/task-scheduler.js'
import { logger } from '../../../src/shared/logger.js'

// ── Helpers ──────────────────────────────────────────────────

/** Safely stop a handle, ignoring errors from already-closed resources */
async function safeStop(handle: BrokerHandle | undefined): Promise<void> {
  if (!handle) return
  try {
    await handle.stop()
  } catch {
    // server may already be closed
  }
}

// ── Tests ────────────────────────────────────────────────────

describe('startBroker', () => {
  let handle: BrokerHandle | undefined
  let savedSignalListeners: {
    SIGINT: ((...args: unknown[]) => unknown)[]
    SIGTERM: ((...args: unknown[]) => unknown)[]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    registeredCleanups.length = 0
    fakeBrokerServer = createFakeBrokerServer()

    // Re-establish logger mock return values (restoreMocks: true clears them between tests)
    const mockChild = {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    }
    mockChild.child.mockReturnValue(mockChild)
    vi.mocked(logger.child).mockReturnValue(mockChild as any)

    // Re-establish mockDb methods (restoreMocks clears mockReturnValue)
    mockDb.pragma.mockReturnValue([{ integrity_check: 'ok' }])
    mockDb.prepare.mockReturnValue({ get: vi.fn(), run: vi.fn(), all: vi.fn() })

    // Capture signal listeners so we can remove them after each test
    savedSignalListeners = { SIGINT: [], SIGTERM: [] }
    const origOnce = process.once.bind(process)
    vi.spyOn(process, 'once').mockImplementation((event: string, listener: any) => {
      if (event === 'SIGINT') savedSignalListeners.SIGINT.push(listener)
      if (event === 'SIGTERM') savedSignalListeners.SIGTERM.push(listener)
      return origOnce(event, listener)
    })
  })

  afterEach(async () => {
    await safeStop(handle)
    handle = undefined

    // Remove signal listeners installed during the test
    for (const l of savedSignalListeners.SIGINT) process.removeListener('SIGINT', l as any)
    for (const l of savedSignalListeners.SIGTERM) process.removeListener('SIGTERM', l as any)

    vi.restoreAllMocks()
  })

  // ── Return value ────────────────────────────────────────

  it('returns a BrokerHandle with server, broker, and stop', async () => {
    handle = await startBroker({ port: 0 })

    expect(handle.server).toBeDefined()
    expect(handle.broker).toBeDefined()
    expect(typeof handle.stop).toBe('function')
  })

  it('server is an http.Server instance that is listening', async () => {
    handle = await startBroker({ port: 0 })

    expect(handle.server.listening).toBe(true)
    const addr = handle.server.address()
    expect(addr).not.toBeNull()
    expect(typeof (addr as { port: number }).port).toBe('number')
  })

  // WI-2a — loopback-by-default bind. The broker used to listen on all
  // interfaces; v1 hardens the default to 127.0.0.1 (all known clients are
  // loopback), overridable via BROKER_BIND / config.bind.
  it('binds to 127.0.0.1 by default (WI-2a)', async () => {
    handle = await startBroker({ port: 0 })
    const addr = handle.server.address() as { address: string }
    expect(addr.address).toBe('127.0.0.1')
  })

  it('honors an explicit bind override (WI-2a)', async () => {
    handle = await startBroker({ port: 0, bind: '0.0.0.0' })
    const addr = handle.server.address() as { address: string }
    expect(addr.address).toBe('0.0.0.0')
  })

  it('broker matches the fake BrokerServer', async () => {
    handle = await startBroker({ port: 0 })

    expect(handle.broker).toBe(fakeBrokerServer)
  })

  // ── Config merging ──────────────────────────────────────

  it('merges partial config over loadConfig defaults', async () => {
    handle = await startBroker({ port: 0, heartbeatIntervalMs: 5000 })

    // loadConfig is called to get defaults
    expect(loadConfig).toHaveBeenCalled()
    // heartbeat poller receives merged config
    expect(startHeartbeatPoller).toHaveBeenCalledWith(
      mockDb,
      mockEventLog,
      expect.objectContaining({ intervalMs: 5000 }),
    )
  })

  it('works with no config argument (uses defaults)', async () => {
    // Default loadConfig returns port 0, so it won't collide
    handle = await startBroker()

    expect(loadConfig).toHaveBeenCalled()
    expect(handle.server.listening).toBe(true)
  })

  // ── Database initialization ─────────────────────────────

  it('ensures DB directory and opens database', async () => {
    handle = await startBroker({ port: 0, dbPath: '/fake/path/data.db' })

    expect(ensureDbDirectory).toHaveBeenCalledWith('/fake/path/data.db')
    expect(openDatabase).toHaveBeenCalledWith('/fake/path/data.db')
  })

  // ── Event log + dispatcher ──────────────────────────────

  it('creates event dispatcher and event log with db + dispatcher', async () => {
    handle = await startBroker({ port: 0 })

    expect(createEventDispatcher).toHaveBeenCalled()
    expect(createEventLog).toHaveBeenCalledWith(mockDb, mockDispatcher)
  })

  // ── Startup cleanup ─────────────────────────────────────

  it('runs startup cleanup with db and event log', async () => {
    handle = await startBroker({ port: 0 })

    expect(cleanupStaleSessionsOnStartup).toHaveBeenCalledWith(mockDb, mockEventLog)
  })

  // ── Heartbeat poller ────────────────────────────────────

  it('starts heartbeat poller with correct interval and grace', async () => {
    handle = await startBroker({ port: 0, heartbeatIntervalMs: 15_000, zombieGraceMs: 120_000 })

    expect(startHeartbeatPoller).toHaveBeenCalledWith(
      mockDb,
      mockEventLog,
      expect.objectContaining({
        intervalMs: 15_000,
        graceSeconds: 120,
      }),
    )
  })

  it('computes graceSeconds by flooring zombieGraceMs / 1000', async () => {
    handle = await startBroker({ port: 0, zombieGraceMs: 250_500 })

    expect(startHeartbeatPoller).toHaveBeenCalledWith(
      mockDb,
      mockEventLog,
      expect.objectContaining({ graceSeconds: 250 }),
    )
  })

  // ── Broker server creation ──────────────────────────────

  it('creates broker server with db, eventLog, shutdownManager, dispatcher', async () => {
    handle = await startBroker({ port: 0 })

    expect(createBrokerServer).toHaveBeenCalledWith(
      mockDb,
      mockEventLog,
      mockShutdownInstance,
      mockDispatcher,
      expect.objectContaining({
        handleSessionEvent: undefined,
        agentSpawner: mockAgentSpawner,
        orchestrator: mockOrchestrator,
        rateMonitor: mockRateMonitor,
      }),
    )
  })

  it('forwards handleSessionEvent option to createBrokerServer', async () => {
    const mockHandler = vi.fn(() => ({ id: 'test-id' }))
    handle = await startBroker({ port: 0, handleSessionEvent: mockHandler })

    expect(createBrokerServer).toHaveBeenCalledWith(
      mockDb,
      mockEventLog,
      mockShutdownInstance,
      mockDispatcher,
      expect.objectContaining({
        handleSessionEvent: mockHandler,
        agentSpawner: mockAgentSpawner,
        orchestrator: mockOrchestrator,
      }),
    )
  })

  // ── Server listening ────────────────────────────────────

  it('logs brokerStarted event with port after listen', async () => {
    handle = await startBroker({ port: 0 })

    expect(mockEventLog.brokerStarted).toHaveBeenCalledWith(
      expect.objectContaining({ port: expect.any(Number) }),
    )
  })

  // ── Shutdown registration ───────────────────────────────

  it('registers fifteen shutdown handlers in order', async () => {
    handle = await startBroker({ port: 0 })

    const labels = registeredCleanups.map((c) => c.label)
    expect(labels).toEqual([
      'recovery-snapshots',
      'team-lifecycle',
      'team-reaper',
      'team-task-autospawner',
      'self-improve-followup-creator',
      'agent-spawner',
      'task-scheduler',
      'health-watchdog',
      'heartbeat-poller',
      'session-discovery',
      'broker-server',
      'http-server',
      'broker-pidfile',
      'reset-embeddings',
      'database',
    ])
  })

  it('heartbeat-poller cleanup calls poller.stop()', async () => {
    handle = await startBroker({ port: 0 })

    const hbCleanup = registeredCleanups.find((c) => c.label === 'heartbeat-poller')!
    await hbCleanup.fn()

    expect(mockHeartbeatPoller.stop).toHaveBeenCalled()
  })

  it('broker-server cleanup calls broker.close()', async () => {
    handle = await startBroker({ port: 0 })

    const brokerCleanup = registeredCleanups.find((c) => c.label === 'broker-server')!
    await brokerCleanup.fn()

    expect(fakeBrokerServer.close).toHaveBeenCalled()
  })

  it('http-server cleanup closes the server', async () => {
    handle = await startBroker({ port: 0 })
    expect(handle.server.listening).toBe(true)

    const httpCleanup = registeredCleanups.find((c) => c.label === 'http-server')!
    await httpCleanup.fn()

    expect(handle.server.listening).toBe(false)
  })

  // #61 — an external supervisor has no portable way to map a listening port
  // back to a pid, so the broker records its own.
  it('records its pid on startup and drops the pidfile on shutdown', async () => {
    pidfileCalls.written.length = 0
    pidfileCalls.removed.length = 0
    handle = await startBroker({ port: 0 })

    expect(pidfileCalls.written).toHaveLength(1)
    expect(pidfileCalls.written[0]!.pid).toBe(process.pid)
    expect(pidfileCalls.written[0]!.path).toContain('broker-')

    await handle.stop()
    expect(pidfileCalls.removed).toContain(pidfileCalls.written[0]!.path)
  })

  it('database cleanup calls closeDatabase', async () => {
    handle = await startBroker({ port: 0 })

    const dbCleanup = registeredCleanups.find((c) => c.label === 'database')!
    await dbCleanup.fn()

    expect(closeDatabase).toHaveBeenCalledWith(mockDb)
  })

  // ── stop() ──────────────────────────────────────────────

  it('stop() logs brokerStopped and triggers shutdownManager.shutdown()', async () => {
    handle = await startBroker({ port: 0 })

    await handle.stop()

    expect(mockEventLog.brokerStopped).toHaveBeenCalledWith(
      expect.objectContaining({ port: expect.any(Number) }),
    )
    expect(mockShutdownInstance.shutdown).toHaveBeenCalled()
  })

  it('stop() runs all registered cleanups in order', async () => {
    handle = await startBroker({ port: 0 })
    const order: string[] = []

    // Replace cleanup fns with tracking stubs
    for (const c of registeredCleanups) {
      const origFn = c.fn
      c.fn = async () => {
        order.push(c.label)
        await origFn()
      }
    }

    await handle.stop()

    expect(order).toEqual([
      'recovery-snapshots',
      'team-lifecycle',
      'team-reaper',
      'team-task-autospawner',
      'self-improve-followup-creator',
      'agent-spawner',
      'task-scheduler',
      'health-watchdog',
      'heartbeat-poller',
      'session-discovery',
      'broker-server',
      'http-server',
      'broker-pidfile',
      'reset-embeddings',
      'database',
    ])
  })

  // ── Signal handling ─────────────────────────────────────

  it('registers SIGINT and SIGTERM handlers', async () => {
    handle = await startBroker({ port: 0 })

    expect(process.once).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(process.once).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
  })

  it('SIGINT handler triggers stop()', async () => {
    handle = await startBroker({ port: 0 })

    expect(savedSignalListeners.SIGINT).toHaveLength(1)
    // Invoke the signal handler
    await savedSignalListeners.SIGINT[0]!()

    expect(mockShutdownInstance.shutdown).toHaveBeenCalled()
  })

  it('SIGTERM handler triggers stop()', async () => {
    handle = await startBroker({ port: 0 })

    expect(savedSignalListeners.SIGTERM).toHaveLength(1)
    await savedSignalListeners.SIGTERM[0]!()

    expect(mockShutdownInstance.shutdown).toHaveBeenCalled()
  })

  // ── Initialization order ────────────────────────────────

  it('initializes components in correct order', async () => {
    const callOrder: string[] = []

    vi.mocked(ensureDbDirectory).mockImplementation(() => {
      callOrder.push('ensureDbDir')
    })
    vi.mocked(openDatabase).mockImplementation(() => {
      callOrder.push('openDb')
      return mockDb as any
    })
    vi.mocked(createEventDispatcher).mockImplementation(() => {
      callOrder.push('dispatcher')
      return mockDispatcher as any
    })
    vi.mocked(createEventLog).mockImplementation(() => {
      callOrder.push('eventLog')
      return mockEventLog as any
    })
    vi.mocked(cleanupStaleSessionsOnStartup).mockImplementation(() => {
      callOrder.push('cleanup')
    })
    vi.mocked(startHeartbeatPoller).mockImplementation(() => {
      callOrder.push('heartbeat')
      return mockHeartbeatPoller as any
    })
    vi.mocked(createBrokerServer).mockImplementation(() => {
      callOrder.push('brokerServer')
      return fakeBrokerServer as any
    })

    handle = await startBroker({ port: 0 })

    expect(callOrder).toEqual([
      'ensureDbDir',
      'openDb',
      'dispatcher',
      'eventLog',
      'cleanup',
      'heartbeat',
      'brokerServer',
    ])
  })

  // ── EADDRINUSE error propagation ────────────────────────

  it('rejects when server emits error (e.g. EADDRINUSE)', async () => {
    // Override createBrokerServer to return a server that errors on listen
    const errorEmitter = new EventEmitter()
    const badBrokerServer = {
      ...fakeBrokerServer,
      app: {
        listen(_port: number) {
          // Emit error asynchronously so the Promise can catch it
          process.nextTick(() => {
            const err: NodeJS.ErrnoException = new Error(
              'listen EADDRINUSE: address already in use',
            )
            err.code = 'EADDRINUSE'
            errorEmitter.emit('error', err)
          })
          return errorEmitter as any
        },
      },
      close: vi.fn(async () => {}),
      transports: new Map(),
    }
    vi.mocked(createBrokerServer).mockReturnValueOnce(badBrokerServer as any)

    await expect(startBroker({ port: 9999 })).rejects.toThrow('EADDRINUSE')
  })

  // ── Task scheduler wiring ─────────────────────────────────

  it('creates task scheduler but does NOT auto-start (waits for startScheduler)', async () => {
    handle = await startBroker({ port: 0 })

    expect(createTaskScheduler).toHaveBeenCalledWith(
      mockDb,
      expect.any(Map),
      expect.objectContaining({ intervalMs: expect.any(Number) }),
    )
    expect(mockScheduler.start).not.toHaveBeenCalled()
  })

  it('registers task-scheduler stop in shutdown handlers', async () => {
    handle = await startBroker({ port: 0 })

    const labels = registeredCleanups.map((c) => c.label)
    expect(labels).toContain('task-scheduler')
  })

  it('task-scheduler cleanup calls scheduler.stop()', async () => {
    handle = await startBroker({ port: 0 })

    const schedulerCleanup = registeredCleanups.find((c) => c.label === 'task-scheduler')!
    expect(schedulerCleanup).toBeDefined()
    await schedulerCleanup.fn()

    expect(mockScheduler.stop).toHaveBeenCalled()
  })

  it('exposes registerTaskHandler on BrokerHandle', async () => {
    handle = await startBroker({ port: 0 })

    expect(typeof handle.registerTaskHandler).toBe('function')

    const handlerFn = vi.fn(async () => {})
    handle.registerTaskHandler('test-task', handlerFn)
    expect(mockScheduler.registerHandler).toHaveBeenCalledWith('test-task', handlerFn)
  })

  it('exposes startScheduler that starts the scheduler', async () => {
    handle = await startBroker({ port: 0 })

    expect(typeof handle.startScheduler).toBe('function')
    expect(mockScheduler.start).not.toHaveBeenCalled()

    handle.startScheduler()
    expect(mockScheduler.start).toHaveBeenCalledOnce()
  })
})

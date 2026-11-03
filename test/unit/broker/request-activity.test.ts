/**
 * The idle signal itself — the thing the whole reaper trusts.
 *
 * Two properties matter, and getting either wrong is quietly catastrophic:
 *
 *  - Monitoring traffic must NOT count. The supervisor probes every child
 *    every 5 seconds; if that registered as demand, every broker would look
 *    permanently busy and idle reaping would never fire once — the feature
 *    would ship dead and nobody would notice.
 *  - Real traffic MUST count. A false "idle" reaps a broker somebody is using.
 *    That is recoverable (the wake path brings it back), but it is still a
 *    cold start charged to a live session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../src/broker/server.js'
import {
  createRequestActivityTracker,
  isMonitoringRequest,
  META_PROBE_HEADER,
} from '../../../src/broker/request-activity.js'

describe('isMonitoringRequest', () => {
  it.each([
    '/api/health',
    '/api/health/',
    '/api/health?verbose=1',
    '/health',
    '/health/live',
    '/health/ready',
    '/api/admin/health',
  ])('treats %s as monitoring', (url) => {
    expect(isMonitoringRequest(url)).toBe(true)
  })

  it.each([
    '/mcp',
    '/api/sessions',
    '/api/memory/store',
    '/api/extension/context',
    '/api/hooks/session-start',
    '/api/admin/drain',
    '/api/brain/wake',
    '/api/meta/resolve?path=/x',
    '/',
  ])('treats %s as demand', (url) => {
    expect(isMonitoringRequest(url)).toBe(false)
  })

  it('treats ANY path as monitoring when the meta-probe header is present', () => {
    // Belt and braces with the path list: the supervisor's probe sets this
    // header, and a future probe against a different endpoint must not
    // silently start counting as demand.
    expect(isMonitoringRequest('/mcp', { [META_PROBE_HEADER]: '1' })).toBe(true)
  })

  it('does not treat a merely similar path as monitoring', () => {
    // `/healthcheck` is somebody else's route, not ours.
    expect(isMonitoringRequest('/healthcheck')).toBe(false)
    expect(isMonitoringRequest('/api/healthz')).toBe(false)
  })
})

describe('createRequestActivityTracker', () => {
  function run(
    tracker: ReturnType<typeof createRequestActivityTracker>,
    url: string,
    headers: Record<string, unknown> = {},
  ): void {
    tracker.middleware(
      { originalUrl: url, url, headers } as never,
      {} as never,
      (() => {}) as never,
    )
  }

  it('starts its idle clock at construction, not at zero', () => {
    // A child nobody ever talks to must age normally — that IS the abandoned
    // broker case. Seeding at 0 would make every fresh child instantly
    // reapable.
    let now = 1_000_000
    const tracker = createRequestActivityTracker(() => now)
    expect(tracker.idleMs()).toBe(0)
    now += 60_000
    expect(tracker.idleMs()).toBe(60_000)
  })

  it('a real request resets the idle clock', () => {
    let now = 1_000_000
    const tracker = createRequestActivityTracker(() => now)
    now += 60_000
    run(tracker, '/mcp')
    expect(tracker.idleMs()).toBe(0)
    now += 5_000
    expect(tracker.idleMs()).toBe(5_000)
  })

  it('REGRESSION GUARD: supervisor probes never reset the idle clock', () => {
    // If this ever passes by resetting, idle reaping is silently disabled:
    // probes arrive every 5s forever, so no child would ever reach 4 hours.
    let now = 1_000_000
    const tracker = createRequestActivityTracker(() => now)
    // Slightly more than 4 hours' worth of 5-second probes.
    const probes = 2_900
    for (let i = 0; i < probes; i++) {
      now += 5_000
      run(tracker, '/api/health', { [META_PROBE_HEADER]: '1' })
    }
    expect(tracker.idleMs()).toBe(probes * 5_000)
    expect(tracker.idleMs()).toBeGreaterThan(4 * 60 * 60 * 1000)
  })

  it('blue/green drain polling does not reset the idle clock either', () => {
    let now = 1_000_000
    const tracker = createRequestActivityTracker(() => now)
    now += 30_000
    run(tracker, '/api/admin/health')
    expect(tracker.idleMs()).toBe(30_000)
  })

  it('never reports a negative idle age', () => {
    const now = 1_000_000
    const tracker = createRequestActivityTracker(() => now)
    expect(tracker.idleMs(now - 10_000)).toBe(0)
  })

  it('always calls next()', () => {
    const tracker = createRequestActivityTracker()
    let called = 0
    const next = (): void => {
      called += 1
    }
    tracker.middleware({ url: '/mcp', headers: {} } as never, {} as never, next as never)
    tracker.middleware({ url: '/api/health', headers: {} } as never, {} as never, next as never)
    expect(called).toBe(2)
  })
})

describe('the broker actually reports the signal over /api/health', () => {
  // Closes the loop: the supervisor's reap decision is only as good as the
  // field it reads off the wire. Without this, the tracker could be perfect
  // and the number still never reach the supervisor.
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    db = openDatabase(':memory:')
    broker = createBrokerServer(db, createEventLog(db))
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  async function health(): Promise<Record<string, unknown>> {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { [META_PROBE_HEADER]: '1' },
    })
    return (await res.json()) as Record<string, unknown>
  }

  it('exposes last_request_age_seconds', async () => {
    const body = await health()
    expect(typeof body['last_request_age_seconds']).toBe('number')
    expect(body['last_request_age_seconds']).toBeGreaterThanOrEqual(0)
  })

  it('self-reports its own pid, which is what makes adoption possible', async () => {
    // The meta-supervisor needs a pid to stop a child it did not spawn, and
    // the registry's `child_pid` is explicitly advisory — it was written by a
    // previous supervisor and the OS may have recycled it. A pid reported by
    // the process that just passed an identity-checked probe cannot be stale.
    const body = await health()
    expect(body['pid']).toBe(process.pid)
  })

  it('a real request resets it, a probe does not', async () => {
    // Age the clock, then confirm probing alone leaves it aged.
    await new Promise((r) => setTimeout(r, 1_100))
    const afterProbesOnly = (await health())['last_request_age_seconds'] as number
    expect(afterProbesOnly).toBeGreaterThanOrEqual(1)

    // A non-monitoring request. 404 is fine — it still reached the process,
    // which is the whole point of the signal.
    await fetch(`${baseUrl}/api/definitely-not-a-route`)
    const afterRealRequest = (await health())['last_request_age_seconds'] as number
    expect(afterRealRequest).toBe(0)
  })
})

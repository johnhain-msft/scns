/**
 * Issue #61 — the self-heal trigger, extracted so the exit can be observed.
 *
 * The trigger used to live inline inside `startBroker`, which meant the single
 * most dangerous line in the codebase — `process.exit(1)` on the assumption
 * that something will relaunch us — had no test at all. On Windows that
 * assumption is false and the exit is a permanent death.
 *
 * The headline test here is `does NOT exit on an unsupervised platform`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import type { TestDb } from '../../../helpers/db-harness.js'
import {
  createSelfHealTrigger,
  type SelfHealTriggerDeps,
} from '../../../../src/broker/services/self-heal-trigger.js'
import {
  DEFAULT_SELF_HEAL_MIN_FAILURES,
  setSelfHealDisabled,
  SELF_HEAL_EXIT_REASON_KEY,
} from '../../../../src/broker/services/self-heal.js'
import { SUPERVISED_ENV } from '../../../../src/broker/services/supervision.js'
import type { HealthCheck } from '../../../../src/broker/services/health-watchdog.js'

let harness: TestDb
let db: import('better-sqlite3').Database

const CHECKS: readonly HealthCheck[] = [
  { name: 'memory', healthy: false, detail: 'rss 2100MB' },
  { name: 'database', healthy: true, detail: 'ok' },
]

beforeEach(() => {
  harness = createBrokerTestDb()
  db = harness.db
})

afterEach(() => {
  harness.close()
})

function makeDeps(overrides: Partial<SelfHealTriggerDeps> = {}): {
  deps: SelfHealTriggerDeps
  exit: ReturnType<typeof vi.fn>
  drain: ReturnType<typeof vi.fn>
  stopWatchdog: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
  const exit = vi.fn()
  const drain = vi.fn(async () => {})
  const stopWatchdog = vi.fn()
  const warn = vi.fn()
  const deps: SelfHealTriggerDeps = {
    db,
    platform: 'darwin',
    env: {},
    drain,
    exit,
    stopWatchdog,
    log: { info: vi.fn(), warn, error: vi.fn() },
    ...overrides,
  }
  return { deps, exit, drain, stopWatchdog, warn }
}

const FAILURES = DEFAULT_SELF_HEAL_MIN_FAILURES

// The drain is a real promise chain, so these assertions are inherently async.
// A generous timeout keeps them from going flaky when the whole suite runs in
// parallel on a loaded Windows box; a passing case still resolves in ~1 tick.
const WAIT = { timeout: 10_000, interval: 10 }

describe('createSelfHealTrigger — arming', () => {
  it('arms on darwin and reports the supervision it is relying on', () => {
    const t = createSelfHealTrigger(makeDeps().deps)
    expect(t.armed).toBe(true)
    expect(t.arming.reason).toBe('supervised')
  })

  it('REFUSES to arm on win32 with no supervisor — the #61 fix', () => {
    const t = createSelfHealTrigger(makeDeps({ platform: 'win32' }).deps)
    expect(t.armed).toBe(false)
    expect(t.arming.reason).toBe('no-relaunch-substrate')
  })

  it('arms on win32 when a supervisor spawned the broker', () => {
    const t = createSelfHealTrigger(
      makeDeps({ platform: 'win32', env: { [SUPERVISED_ENV]: '1' } }).deps,
    )
    expect(t.armed).toBe(true)
  })

  it('logs a warning once at construction when it refuses to arm', () => {
    const h = makeDeps({ platform: 'win32' })
    createSelfHealTrigger(h.deps)
    expect(h.warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(h.warn.mock.calls)).toMatch(/self-heal/i)
  })

  it('does not warn when it arms normally', () => {
    const h = makeDeps()
    createSelfHealTrigger(h.deps)
    expect(h.warn).not.toHaveBeenCalled()
  })
})

describe('createSelfHealTrigger — firing', () => {
  it('drains then exits(1) when armed and the decision says restart', async () => {
    const h = makeDeps()
    const t = createSelfHealTrigger(h.deps)
    t.trigger(FAILURES, CHECKS)
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(1), WAIT)
    expect(h.drain).toHaveBeenCalledTimes(1)
    expect(h.stopWatchdog).toHaveBeenCalledTimes(1)
  })

  it('records the dominant unhealthy check as the exit reason', async () => {
    const h = makeDeps()
    createSelfHealTrigger(h.deps).trigger(FAILURES, CHECKS)
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalled(), WAIT)
    const row = db
      .prepare('SELECT value FROM shared_state WHERE key = ?')
      .get(SELF_HEAL_EXIT_REASON_KEY) as { value: string } | undefined
    expect(row?.value).toBe('self_heal:memory')
  })

  it('NEVER exits on an unsupervised platform, however unhealthy it gets', async () => {
    const h = makeDeps({ platform: 'win32' })
    const t = createSelfHealTrigger(h.deps)
    for (let i = 0; i < 20; i += 1) t.trigger(FAILURES + i, CHECKS)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.exit).not.toHaveBeenCalled()
    expect(h.drain).not.toHaveBeenCalled()
    // Bookkeeping must NOT be recorded either — no restart happened, so a
    // cooldown/escalation entry would be a lie the next process reads.
    const row = db
      .prepare('SELECT value FROM shared_state WHERE key = ?')
      .get(SELF_HEAL_EXIT_REASON_KEY) as { value: string } | undefined
    expect(row).toBeUndefined()
  })

  it('still exits when the operator forces self-heal on an unsupervised host', async () => {
    const h = makeDeps({ platform: 'win32', env: { SCNS_BROKER_SELF_HEAL: '1' } })
    createSelfHealTrigger(h.deps).trigger(FAILURES, CHECKS)
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(1), WAIT)
  })

  it('honours SCNS_BROKER_SELF_HEAL=0 on a supervised platform', async () => {
    const h = makeDeps({ env: { SCNS_BROKER_SELF_HEAL: '0' } })
    const t = createSelfHealTrigger(h.deps)
    expect(t.armed).toBe(false)
    t.trigger(FAILURES, CHECKS)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.exit).not.toHaveBeenCalled()
  })

  it('does not fire below the consecutive-failure threshold', async () => {
    const h = makeDeps()
    createSelfHealTrigger(h.deps).trigger(FAILURES - 1, CHECKS)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.exit).not.toHaveBeenCalled()
  })

  it('respects the persisted kill-switch', async () => {
    setSelfHealDisabled(db, true)
    const h = makeDeps()
    createSelfHealTrigger(h.deps).trigger(FAILURES, CHECKS)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.exit).not.toHaveBeenCalled()
  })

  it('is re-entrancy guarded — a second trigger during the drain is a no-op', async () => {
    const h = makeDeps({ drain: vi.fn(() => new Promise<void>(() => {})) })
    const t = createSelfHealTrigger(h.deps)
    t.trigger(FAILURES, CHECKS)
    t.trigger(FAILURES, CHECKS)
    t.trigger(FAILURES, CHECKS)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.deps.drain).toHaveBeenCalledTimes(1)
  })

  it('forces exit(1) when the drain itself fails', async () => {
    const h = makeDeps({ drain: vi.fn(async () => Promise.reject(new Error('drain blew up'))) })
    createSelfHealTrigger(h.deps).trigger(FAILURES, CHECKS)
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(1), WAIT)
  })

  it('does not restart blind when the self-heal decision throws (db is the sick subsystem)', async () => {
    const broken = {
      prepare: () => {
        throw new Error('database disk image is malformed')
      },
    } as unknown as import('better-sqlite3').Database
    const h = makeDeps({ db: broken })
    createSelfHealTrigger(h.deps).trigger(FAILURES, CHECKS)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.exit).not.toHaveBeenCalled()
  })
})

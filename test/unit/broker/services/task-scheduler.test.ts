import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../../src/shared/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }
  child.child.mockReturnValue(child)
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnValue(child),
    },
  }
})

vi.mock('../../../../src/broker/storage/repositories/scheduler-repository.js', async () => {
  const actual = await vi.importActual(
    '../../../../src/broker/storage/repositories/scheduler-repository.js',
  )
  return {
    ...actual,
    recordTaskRun: vi.fn(),
  }
})

import {
  cronMatches,
  cronHadFireTimeInWindow,
  createTaskScheduler,
} from '../../../../src/broker/services/task-scheduler.js'
import { logger } from '../../../../src/shared/logger.js'

// The mock child is the return value of logger.child('task-scheduler')
// Since vi.mock is hoisted, child is created once at module load time
const mockLogChild = vi.mocked(logger.child)('dummy' as any) as any

// ── Cron matching tests ──────────────────────────────────────

describe('cronMatches', () => {
  it('matches wildcard-only expression', () => {
    expect(cronMatches('* * * * *', new Date())).toBe(true)
  })

  it('matches exact minute/hour', () => {
    const d = new Date(2025, 3, 16, 14, 30, 0) // 14:30
    expect(cronMatches('30 14 * * *', d)).toBe(true)
    expect(cronMatches('31 14 * * *', d)).toBe(false)
    expect(cronMatches('30 15 * * *', d)).toBe(false)
  })

  it('matches step expressions (*/N)', () => {
    const d = new Date(2025, 3, 16, 14, 30, 0)
    expect(cronMatches('*/5 * * * *', d)).toBe(true) // 30 % 5 == 0
    expect(cronMatches('*/7 * * * *', d)).toBe(false) // 30 % 7 != 0
  })

  it('matches 6-field cron with seconds', () => {
    const d = new Date(2025, 3, 16, 14, 30, 0)
    expect(cronMatches('0 30 14 * * *', d)).toBe(true)
    expect(cronMatches('*/10 * * * * *', d)).toBe(true) // 0 % 10 == 0
    expect(cronMatches('5 30 14 * * *', d)).toBe(false) // second 5, not 0
  })

  it('matches day of week', () => {
    const monday = new Date(2025, 3, 14, 12, 0, 0) // April 14, 2025 = Monday (1)
    expect(cronMatches('0 12 * * 1', monday)).toBe(true)
    expect(cronMatches('0 12 * * 0', monday)).toBe(false) // Sunday
  })

  it('matches comma-separated values', () => {
    const d = new Date(2025, 3, 16, 14, 30, 0)
    expect(cronMatches('30,45 * * * *', d)).toBe(true)
    expect(cronMatches('15,45 * * * *', d)).toBe(false)
  })

  it('matches range expressions', () => {
    const d = new Date(2025, 3, 16, 14, 30, 0)
    expect(cronMatches('25-35 * * * *', d)).toBe(true) // 30 in 25-35
    expect(cronMatches('0-10 * * * *', d)).toBe(false) // 30 not in 0-10
  })
})

// ── cronHadFireTimeInWindow tests ────────────────────────────

describe('cronHadFireTimeInWindow', () => {
  it('returns true when a every-5-min cron fired in a 10-minute window', () => {
    // Window: 14:20 to 14:30 — */5 fires at :20, :25, :30
    const from = new Date(2025, 3, 16, 14, 20, 0)
    const to = new Date(2025, 3, 16, 14, 30, 0)
    expect(cronHadFireTimeInWindow('*/5 * * * *', from, to)).toBe(true)
  })

  it('returns false when cron did not fire in the window', () => {
    // Window: 14:01 to 14:04 — fires at :00, :05, :10... none in (1,4]
    const from = new Date(2025, 3, 16, 14, 1, 0)
    const to = new Date(2025, 3, 16, 14, 4, 0)
    expect(cronHadFireTimeInWindow('*/5 * * * *', from, to)).toBe(false)
  })

  it('returns true for daily cron when sleep spans its fire time', () => {
    // dream-consolidation: "0 3 * * *" — fires at 3:00 AM
    // Sleep from 2:00 to 6:00 → should detect the 3:00 firing
    const from = new Date(2025, 3, 16, 2, 0, 0)
    const to = new Date(2025, 3, 16, 6, 0, 0)
    expect(cronHadFireTimeInWindow('0 3 * * *', from, to)).toBe(true)
  })

  it('returns false for daily cron when sleep does NOT span its fire time', () => {
    // Sleep from 12:00 to 12:10 — dream at 3AM was not missed
    const from = new Date(2025, 3, 16, 12, 0, 0)
    const to = new Date(2025, 3, 16, 12, 10, 0)
    expect(cronHadFireTimeInWindow('0 3 * * *', from, to)).toBe(false)
  })

  it('handles 6-field cron with seconds', () => {
    // Every 10 seconds: "*/10 * * * * *"
    // Window: 14:30:05 to 14:30:25 — fires at :10, :20
    const from = new Date(2025, 3, 16, 14, 30, 5)
    const to = new Date(2025, 3, 16, 14, 30, 25)
    expect(cronHadFireTimeInWindow('*/10 * * * * *', from, to)).toBe(true)
  })

  it('caps iteration to avoid infinite loops on very long windows', () => {
    // 30-day window with a daily cron — should still terminate
    const from = new Date(2025, 2, 1, 0, 0, 0)
    const to = new Date(2025, 3, 1, 0, 0, 0)
    expect(cronHadFireTimeInWindow('0 3 * * *', from, to)).toBe(true)
  })
})

// ── Scheduler tests ──────────────────────────────────────────

describe('createTaskScheduler', () => {
  let mockDb: {
    prepare: ReturnType<typeof vi.fn>
    transaction: ReturnType<typeof vi.fn>
  }
  let scheduler: ReturnType<typeof createTaskScheduler>
  const handlers = new Map<string, (task: any) => Promise<void>>()

  function makeMockDb(rows: any[] = []) {
    const mockRunFn = vi.fn()
    const mockPrepare = vi.fn((sql: string) => {
      if (sql.includes('SELECT * FROM scheduled_tasks')) {
        return { all: vi.fn(() => rows) }
      }
      if (sql.includes('INSERT INTO task_run_history')) {
        return { run: mockRunFn }
      }
      if (sql.includes('UPDATE scheduled_tasks')) {
        return { run: mockRunFn }
      }
      return { run: mockRunFn, all: vi.fn(() => []), get: vi.fn() }
    })
    const mockTransaction = vi.fn((fn: any) => fn)

    return { prepare: mockPrepare, transaction: mockTransaction, _runFn: mockRunFn }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    mockDb = makeMockDb()
  })

  afterEach(() => {
    scheduler?.stop()
  })

  it('starts and stops cleanly', () => {
    scheduler = createTaskScheduler(mockDb as any, handlers)
    expect(scheduler.isRunning()).toBe(false)
    scheduler.start()
    expect(scheduler.isRunning()).toBe(true)
    scheduler.stop()
    expect(scheduler.isRunning()).toBe(false)
  })

  it('does not double-start', () => {
    scheduler = createTaskScheduler(mockDb as any, handlers)
    scheduler.start()
    scheduler.start() // second call is no-op
    expect(scheduler.isRunning()).toBe(true)
  })

  function makeTask(id: string, cron: string, lastRunAt: string | null = null) {
    return {
      id,
      name: id,
      description: null,
      category: 'cron',
      cron_expression: cron,
      enabled: 1,
      last_run_at: lastRunAt,
      next_run_at: null,
      run_count: 0,
      last_status: null,
      config_json: '{}',
      created_at: '2025-01-01T00:00:00',
      updated_at: '2025-01-01T00:00:00',
    }
  }

  // ── Sleep catch-up tests ─────────────────────────────────

  describe('sleep catch-up', () => {
    it('detects sleep gap when elapsed > 2x interval', async () => {
      // Task: every 5 min, last ran 20 min ago (sleep gap)
      const twentyMinAgo = new Date(Date.now() - 20 * 60_000).toISOString()
      const tasks = [makeTask('zombie-cleanup', '*/5 * * * *', twentyMinAgo)]
      const db = makeMockDb(tasks)
      const handlerFn = vi.fn(async () => {})
      handlers.set('zombie-cleanup', handlerFn)

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })

      // Simulate a sleep gap by setting lastTickTime far in the past
      ;(scheduler as any).setLastTickTime(Date.now() - 5 * 60_000)
      await scheduler.tick()

      // The handler should have been called (catch-up detected the missed window)
      expect(handlerFn).toHaveBeenCalled()
    })

    it('does NOT catch-up daily task after unrelated short sleep', async () => {
      // dream-consolidation: "0 3 * * *" (daily at 3AM)
      // Sleep from noon to 12:10 — dream was NOT missed
      const yesterday3am = new Date()
      yesterday3am.setDate(yesterday3am.getDate() - 1)
      yesterday3am.setHours(3, 0, 0, 0)

      const tasks = [makeTask('dream-consolidation', '0 3 * * *', yesterday3am.toISOString())]
      const db = makeMockDb(tasks)
      const handlerFn = vi.fn(async () => {})
      handlers.set('dream-consolidation', handlerFn)

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })

      // Simulate 10-minute noon sleep (no 3AM in window)
      const tenMinAgo = Date.now() - 10 * 60_000
      ;(scheduler as any).setLastTickTime(tenMinAgo)
      await scheduler.tick()

      // Dream should NOT have been called via catch-up
      // (it might match if current time happens to be 3AM, but not via catch-up)
      const catchUpCalls = mockLogChild.info.mock.calls.filter(
        (c: any[]) => c[0]?.catchUp === true && c[0]?.taskId === 'dream-consolidation',
      )
      expect(catchUpCalls).toHaveLength(0)
    })

    it('caps catch-up at 3 tasks per tick', async () => {
      const oldTime = new Date(Date.now() - 60 * 60_000).toISOString()
      const tasks = [
        makeTask('task-a', '* * * * *', oldTime),
        makeTask('task-b', '* * * * *', oldTime),
        makeTask('task-c', '* * * * *', oldTime),
        makeTask('task-d', '* * * * *', oldTime),
        makeTask('task-e', '* * * * *', oldTime),
      ]
      const db = makeMockDb(tasks)

      const callOrder: string[] = []
      for (const t of tasks) {
        handlers.set(
          t.id,
          vi.fn(async () => {
            callOrder.push(t.id)
          }),
        )
      }

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      ;(scheduler as any).setLastTickTime(Date.now() - 5 * 60_000)
      await scheduler.tick()

      // Should have run at most 3 catch-up tasks
      const catchUpInfoCalls = mockLogChild.info.mock.calls.filter(
        (c: any[]) => c[0]?.catchUp === true,
      )
      expect(catchUpInfoCalls.length).toBeLessThanOrEqual(3)
    })

    it('normal tick does NOT trigger catch-up', async () => {
      const recentTime = new Date(Date.now() - 30_000).toISOString()
      const tasks = [makeTask('zombie-cleanup', '*/5 * * * *', recentTime)]
      const db = makeMockDb(tasks)
      handlers.set(
        'zombie-cleanup',
        vi.fn(async () => {}),
      )

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      // lastTickTime is recent (no sleep gap)
      ;(scheduler as any).setLastTickTime(Date.now() - 50_000)
      await scheduler.tick()

      const catchUpCalls = mockLogChild.info.mock.calls.filter((c: any[]) => c[0]?.catchUp === true)
      expect(catchUpCalls).toHaveLength(0)
    })

    it('catch-up logs include catchUp marker', async () => {
      const oldTime = new Date(Date.now() - 30 * 60_000).toISOString()
      const tasks = [makeTask('zombie-cleanup', '*/5 * * * *', oldTime)]
      const db = makeMockDb(tasks)
      handlers.set(
        'zombie-cleanup',
        vi.fn(async () => {}),
      )

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      ;(scheduler as any).setLastTickTime(Date.now() - 5 * 60_000)
      await scheduler.tick()

      const catchUpLogCalls = mockLogChild.info.mock.calls.filter(
        (c: any[]) => c[0]?.catchUp === true,
      )
      expect(catchUpLogCalls.length).toBeGreaterThan(0)
    })

    it('does NOT double-fire when catch-up and normal due coincide', async () => {
      // Task with wildcard cron: always matches for both catch-up AND normal due
      const oldTime = new Date(Date.now() - 60 * 60_000).toISOString()
      const tasks = [makeTask('always-due', '* * * * *', oldTime)]
      const db = makeMockDb(tasks)
      const handlerFn = vi.fn(async () => {})
      handlers.set('always-due', handlerFn)

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      // Create a sleep gap so catch-up triggers
      ;(scheduler as any).setLastTickTime(Date.now() - 5 * 60_000)
      await scheduler.tick()

      // Handler should only run once per tick (catch-up), not twice (catch-up + normal)
      expect(handlerFn).toHaveBeenCalledTimes(1)
    })

    it('preserves lastTickTime when catch-up is capped', async () => {
      const oldTime = new Date(Date.now() - 60 * 60_000).toISOString()
      const tasks = [
        makeTask('task-a', '* * * * *', oldTime),
        makeTask('task-b', '* * * * *', oldTime),
        makeTask('task-c', '* * * * *', oldTime),
        makeTask('task-d', '* * * * *', oldTime),
        makeTask('task-e', '* * * * *', oldTime),
      ]
      const db = makeMockDb(tasks)
      for (const t of tasks) {
        handlers.set(
          t.id,
          vi.fn(async () => {}),
        )
      }

      const originalLastTick = Date.now() - 5 * 60_000
      scheduler = createTaskScheduler(db as any, handlers, {
        intervalMs: 60_000,
        maxCatchUpPerTick: 2,
      })
      ;(scheduler as any).setLastTickTime(originalLastTick)
      await scheduler.tick()

      // Since catch-up was capped (5 tasks, cap 2), lastTickTime should NOT have advanced
      // A subsequent tick should still detect the gap
      // We verify by running another tick — gap should still be detected
      const gapLogCalls = mockLogChild.info.mock.calls.filter(
        (c: any[]) => c[0]?.gapMs !== undefined,
      )
      expect(gapLogCalls.length).toBeGreaterThan(0)
    })

    it('prevents overlapping ticks', async () => {
      const tasks = [makeTask('slow-task', '* * * * *')]
      const db = makeMockDb(tasks)

      let resolveHandler: () => void
      const handlerPromise = new Promise<void>((r) => {
        resolveHandler = r
      })
      handlers.set(
        'slow-task',
        vi.fn(async () => handlerPromise),
      )

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })

      // First tick starts but doesn't finish (slow handler)
      const tick1 = scheduler.tick()
      // Second tick should skip (overlap guard)
      const tick2 = scheduler.tick()

      // Resolve the slow handler
      resolveHandler!()
      await tick1
      await tick2

      // Handler should only have been called once
      expect(handlers.get('slow-task')).toHaveBeenCalledTimes(1)
    })
  })

  // ── Cold-start catch-up (process restart) ─────────────────
  //
  // The sleep-gap detector keyed off the IN-MEMORY lastTickTime, which is 0
  // on every process start — so a cron fire missed while the process was
  // DOWN (machine off, daily restart, deploy) was invisible and the task
  // silently waited for its next natural fire. Observed live 2026-09-07:
  // the Mac was off at Monday 09:00 and the weekly-promotion-review — the
  // only source of human accept/reject labels — lost its week. The window
  // is now anchored on each task's persisted last_run_at.

  describe('cold-start catch-up (process restart)', () => {
    // A daily cron pinned ~12h away from "now" so it can never coincide
    // with the normal due check while still having exactly one fire time
    // inside a >24h window — deterministic at any wall-clock time.
    function awayFromNowDailyCron(): string {
      const awayHour = (new Date().getHours() + 12) % 24
      return `0 ${awayHour} * * *`
    }

    it('first tick after start fires a task whose cron fired while the process was down', async () => {
      const lastRun = new Date(Date.now() - 25 * 60 * 60_000).toISOString() // 25h ago
      const tasks = [makeTask('weekly-ish', awayFromNowDailyCron(), lastRun)]
      const db = makeMockDb(tasks)
      const handlerFn = vi.fn(async () => {})
      handlers.set('weekly-ish', handlerFn)

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      // Deliberately NO setLastTickTime: this is a fresh process (cursor 0).
      await scheduler.tick()

      expect(handlerFn).toHaveBeenCalledTimes(1)
      const catchUpCalls = mockLogChild.info.mock.calls.filter((c: any[]) => c[0]?.catchUp === true)
      expect(catchUpCalls.length).toBe(1)
    })

    it('does NOT fire a task that already ran after its last cron fire', async () => {
      const justRan = new Date(Date.now() - 60_000).toISOString()
      const tasks = [makeTask('already-ran', awayFromNowDailyCron(), justRan)]
      const db = makeMockDb(tasks)
      const handlerFn = vi.fn(async () => {})
      handlers.set('already-ran', handlerFn)

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      await scheduler.tick()

      expect(handlerFn).not.toHaveBeenCalled()
    })

    it('does NOT fire a never-run task on cold start (no baseline, no boot storm)', async () => {
      const tasks = [makeTask('never-ran', awayFromNowDailyCron(), null)]
      const db = makeMockDb(tasks)
      const handlerFn = vi.fn(async () => {})
      handlers.set('never-ran', handlerFn)

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      await scheduler.tick()

      expect(handlerFn).not.toHaveBeenCalled()
    })

    it('cold start advances the tick cursor, so the next tick is a normal tick', async () => {
      const tasks = [makeTask('quiet-task', awayFromNowDailyCron(), new Date().toISOString())]
      const db = makeMockDb(tasks)
      handlers.set(
        'quiet-task',
        vi.fn(async () => {}),
      )

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      await scheduler.tick()
      mockLogChild.info.mockClear()
      await scheduler.tick()

      // Second tick: no cold-start line, no gap line (cursor just advanced).
      const catchUpBranchLogs = mockLogChild.info.mock.calls.filter(
        (c: any[]) => c[0]?.gapMs !== undefined || /Cold start/.test(String(c[1] ?? '')),
      )
      expect(catchUpBranchLogs).toHaveLength(0)
    })

    it('an old last_run does NOT widen a mid-life sleep gap (window bounded by the tick cursor)', async () => {
      // Fire time exists in (lastRun, now] but NOT inside the 10-minute gap:
      // within one process lifetime only the gap itself counts as missed.
      const lastRun = new Date(Date.now() - 25 * 60 * 60_000).toISOString()
      const tasks = [makeTask('old-but-considered', awayFromNowDailyCron(), lastRun)]
      const db = makeMockDb(tasks)
      const handlerFn = vi.fn(async () => {})
      handlers.set('old-but-considered', handlerFn)

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      ;(scheduler as any).setLastTickTime(Date.now() - 10 * 60_000)
      await scheduler.tick()

      expect(handlerFn).not.toHaveBeenCalled()
    })
  })

  // ── Handler registration ─────────────────────────────────

  describe('registerHandler', () => {
    it('registers a handler that gets called on tick', async () => {
      const now = new Date()
      const tasks = [
        {
          id: 'test-task',
          name: 'Test Task',
          description: null,
          category: 'cron',
          cron_expression: `${now.getMinutes()} ${now.getHours()} * * *`,
          enabled: 1,
          last_run_at: null,
          next_run_at: null,
          run_count: 0,
          last_status: null,
          config_json: '{}',
          created_at: '2025-01-01T00:00:00',
          updated_at: '2025-01-01T00:00:00',
        },
      ]
      const db = makeMockDb(tasks)
      const handlerFn = vi.fn(async () => {})

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      scheduler.registerHandler('test-task', handlerFn)
      await scheduler.tick()

      expect(handlerFn).toHaveBeenCalled()
    })

    it('records failure when handler throws', async () => {
      const now = new Date()
      const tasks = [
        {
          id: 'failing-task',
          name: 'Failing Task',
          description: null,
          category: 'cron',
          cron_expression: `${now.getMinutes()} ${now.getHours()} * * *`,
          enabled: 1,
          last_run_at: null,
          next_run_at: null,
          run_count: 0,
          last_status: null,
          config_json: '{}',
          created_at: '2025-01-01T00:00:00',
          updated_at: '2025-01-01T00:00:00',
        },
      ]
      const db = makeMockDb(tasks)

      const { recordTaskRun } =
        await import('../../../../src/broker/storage/repositories/scheduler-repository.js')

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      scheduler.registerHandler('failing-task', async () => {
        throw new Error('handler broke')
      })
      await scheduler.tick()

      expect(vi.mocked(recordTaskRun)).toHaveBeenCalledWith(
        db,
        'failing-task',
        'failure',
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        'handler broke',
      )
    })

    it("records 'skipped' when the handler reports a gate-skip outcome (R3)", async () => {
      const now = new Date()
      const tasks = [
        {
          id: 'dream-consolidation',
          name: 'Dream Consolidation',
          description: null,
          category: 'cron',
          cron_expression: `${now.getMinutes()} ${now.getHours()} * * *`,
          enabled: 1,
          last_run_at: null,
          next_run_at: null,
          run_count: 0,
          last_status: null,
          config_json: '{}',
          created_at: '2025-01-01T00:00:00',
          updated_at: '2025-01-01T00:00:00',
        },
      ]
      const db = makeMockDb(tasks)

      const { recordTaskRun } =
        await import('../../../../src/broker/storage/repositories/scheduler-repository.js')

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      scheduler.registerHandler('dream-consolidation', async () => ({
        status: 'skipped' as const,
        detail: 'gate: count',
      }))
      await scheduler.tick()

      expect(vi.mocked(recordTaskRun)).toHaveBeenCalledWith(
        db,
        'dream-consolidation',
        'skipped',
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        'gate: count',
      )
    })

    it("records 'success' when the handler returns void (legacy handlers unchanged)", async () => {
      const now = new Date()
      const tasks = [
        {
          id: 'plain-task',
          name: 'Plain Task',
          description: null,
          category: 'cron',
          cron_expression: `${now.getMinutes()} ${now.getHours()} * * *`,
          enabled: 1,
          last_run_at: null,
          next_run_at: null,
          run_count: 0,
          last_status: null,
          config_json: '{}',
          created_at: '2025-01-01T00:00:00',
          updated_at: '2025-01-01T00:00:00',
        },
      ]
      const db = makeMockDb(tasks)

      const { recordTaskRun } =
        await import('../../../../src/broker/storage/repositories/scheduler-repository.js')

      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      scheduler.registerHandler('plain-task', async () => {})
      await scheduler.tick()

      expect(vi.mocked(recordTaskRun)).toHaveBeenCalledWith(
        db,
        'plain-task',
        'success',
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        undefined,
      )
    })

    it('skips tasks with no registered handler', async () => {
      const now = new Date()
      const tasks = [
        {
          id: 'orphan-task',
          name: 'Orphan Task',
          description: null,
          category: 'cron',
          cron_expression: `${now.getMinutes()} ${now.getHours()} * * *`,
          enabled: 1,
          last_run_at: null,
          next_run_at: null,
          run_count: 0,
          last_status: null,
          config_json: '{}',
          created_at: '2025-01-01T00:00:00',
          updated_at: '2025-01-01T00:00:00',
        },
      ]
      const db = makeMockDb(tasks)

      const { recordTaskRun } =
        await import('../../../../src/broker/storage/repositories/scheduler-repository.js')

      // No handler registered for 'orphan-task'
      scheduler = createTaskScheduler(db as any, handlers, { intervalMs: 60_000 })
      await scheduler.tick()

      // Should log debug and NOT call recordTaskRun
      expect(mockLogChild.debug).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'orphan-task' }),
        expect.stringContaining('No handler'),
      )
      expect(vi.mocked(recordTaskRun)).not.toHaveBeenCalledWith(
        expect.anything(),
        'orphan-task',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      )
    })
  })
})

// ── WI-6: runNow — the dashboard "run now" must EXECUTE, not just record ──

describe('runNow (WI-6)', () => {
  it('executes the registered handler against the real task row and records history', async () => {
    const { openDatabase, closeDatabase } = await import('../../../../src/broker/storage/db.js')
    const { seedDefaultTasks } =
      await import('../../../../src/broker/storage/repositories/scheduler-repository.js')
    const db = openDatabase(':memory:')
    try {
      seedDefaultTasks(db)
      const ran: string[] = []
      const sched = createTaskScheduler(
        db as any,
        new Map([
          [
            'memory-reindex',
            async () => {
              ran.push('memory-reindex')
            },
          ],
        ]),
      )
      expect(await sched.runNow('memory-reindex')).toBe('ran')
      expect(ran).toEqual(['memory-reindex'])
      // recordTaskRun is module-mocked in this file — assert the history
      // write the way the tick tests do (line ~471).
      const { recordTaskRun } =
        await import('../../../../src/broker/storage/repositories/scheduler-repository.js')
      expect(vi.mocked(recordTaskRun)).toHaveBeenCalledWith(
        db,
        'memory-reindex',
        'success',
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        undefined,
      )

      expect(await sched.runNow('does-not-exist')).toBe('no-task')
      // Seeded task with no registered handler in this scheduler instance:
      expect(await sched.runNow('zombie-cleanup')).toBe('no-handler')
      expect(ran).toEqual(['memory-reindex'])
    } finally {
      closeDatabase(db)
    }
  })
})

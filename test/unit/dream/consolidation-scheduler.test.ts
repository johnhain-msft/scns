import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  createConsolidationScheduler,
  initConsolidationState,
} from '../../../src/dream/consolidation-scheduler.js'

describe('consolidation-scheduler', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initConsolidationState(db)
  })

  afterEach(() => {
    db.close()
  })

  it('shouldRunWeekly returns true on first run (no history)', () => {
    const sched = createConsolidationScheduler(db)
    expect(sched.shouldRunWeekly()).toBe(true)
  })

  it('shouldRunWeekly returns false immediately after a weekly run', () => {
    const sched = createConsolidationScheduler(db)
    sched.recordWeeklyRun()
    expect(sched.shouldRunWeekly()).toBe(false)
  })

  it('shouldRunWeekly returns true after 7+ days', () => {
    const sched = createConsolidationScheduler(db)
    // Set last weekly to 8 days ago
    db.prepare("UPDATE consolidation_schedule SET last_weekly_at = datetime('now', '-8 days')").run()
    expect(sched.shouldRunWeekly()).toBe(true)
  })

  it('shouldRunMonthly returns true on first run (no history)', () => {
    const sched = createConsolidationScheduler(db)
    expect(sched.shouldRunMonthly()).toBe(true)
  })

  it('shouldRunMonthly returns false immediately after a monthly run', () => {
    const sched = createConsolidationScheduler(db)
    sched.recordMonthlyRun()
    expect(sched.shouldRunMonthly()).toBe(false)
  })

  it('shouldRunMonthly returns true after 30+ days', () => {
    const sched = createConsolidationScheduler(db)
    db.prepare(
      "UPDATE consolidation_schedule SET last_monthly_at = datetime('now', '-31 days')",
    ).run()
    expect(sched.shouldRunMonthly()).toBe(true)
  })

  it('getSchedule returns current state', () => {
    const sched = createConsolidationScheduler(db)
    const state = sched.getSchedule()
    expect(state.lastWeeklyAt).toBeNull()
    expect(state.lastMonthlyAt).toBeNull()
  })

  it('getSchedule reflects recorded runs', () => {
    const sched = createConsolidationScheduler(db)
    sched.recordWeeklyRun()
    sched.recordMonthlyRun()
    const state = sched.getSchedule()
    expect(state.lastWeeklyAt).toBeTruthy()
    expect(state.lastMonthlyAt).toBeTruthy()
  })

  it('weekly and monthly are independent', () => {
    const sched = createConsolidationScheduler(db)
    sched.recordWeeklyRun()
    expect(sched.shouldRunWeekly()).toBe(false)
    expect(sched.shouldRunMonthly()).toBe(true)
  })
})

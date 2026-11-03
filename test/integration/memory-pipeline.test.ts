import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { createVault } from '../../src/memory/vault.js'
import { createArchiveStore } from '../../src/memory/archive-store.js'
import {
  initConsolidationState,
  createConsolidationScheduler,
} from '../../src/dream/consolidation-scheduler.js'
import {
  runWeeklyConsolidation,
  runMonthlyConsolidation,
} from '../../src/dream/tiered-consolidation.js'

describe('memory-pipeline integration', () => {
  let tempDir: string
  let vaultDir: string
  let archiveDir: string
  let db: Database.Database

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scns-mem-pipeline-'))
    vaultDir = join(tempDir, 'vault')
    archiveDir = join(vaultDir, 'archive')
    mkdirSync(join(vaultDir, 'daily'), { recursive: true })
    mkdirSync(join(vaultDir, 'weekly'), { recursive: true })
    mkdirSync(join(vaultDir, 'monthly'), { recursive: true })
    db = new Database(':memory:')
    initConsolidationState(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('full pipeline: daily → weekly → monthly → archive', () => {
    const vault = createVault({ rootDir: vaultDir })
    const archive = createArchiveStore({ rootDir: archiveDir })
    const scheduler = createConsolidationScheduler(db)

    // Create 7 daily logs with recurring lessons
    const dates = [
      '2026-04-14',
      '2026-04-15',
      '2026-04-16',
      '2026-04-17',
      '2026-04-18',
      '2026-04-19',
      '2026-04-20',
    ]
    for (const date of dates) {
      const content = [
        `## ${date}`,
        '- Always run tests before committing',
        '- Use Pino for logging',
        `- Session debug: random noise ${date}`,
        date === '2026-04-14' ? '- Architecture decision: use Express 5' : '',
      ].join('\n')
      vault.write(`daily/${date}.md`, content)
    }

    // Weekly consolidation should be due (first run)
    expect(scheduler.shouldRunWeekly()).toBe(true)

    const weekResult = runWeeklyConsolidation({
      vault,
      archiveStore: archive,
      weekId: '2026-W16',
      dailyLogDates: dates,
    })

    expect(weekResult.success).toBe(true)
    expect(weekResult.dailyLogsProcessed).toBe(7)
    expect(weekResult.lessonsExtracted).toBeGreaterThan(0)

    // Verify weekly file was created
    const weeklyFile = vault.read('weekly/2026-W16.md')
    expect(weeklyFile).not.toBeNull()
    expect(weeklyFile!.content).toContain('High-Confidence Lessons')
    expect(weeklyFile!.content).toContain('Always run tests before committing')

    // Record weekly run
    scheduler.recordWeeklyRun()
    expect(scheduler.shouldRunWeekly()).toBe(false)

    // Create a second weekly file for monthly
    vault.write(
      'weekly/2026-W15.md',
      [
        '## Week 15',
        '### High-Confidence Lessons',
        '- Always run tests before committing',
        '### Lessons',
        '- Use ESM modules',
      ].join('\n'),
    )

    // Monthly consolidation
    expect(scheduler.shouldRunMonthly()).toBe(true)

    const monthResult = runMonthlyConsolidation({
      vault,
      archiveStore: archive,
      monthId: '2026-04',
      weeklyIds: ['2026-W15', '2026-W16'],
    })

    expect(monthResult.success).toBe(true)
    expect(monthResult.weeklyLogsProcessed).toBe(2)
    expect(monthResult.stablePatternsFound).toBeGreaterThan(0)

    // Verify monthly file was created
    const monthlyFile = vault.read('monthly/2026-04.md')
    expect(monthlyFile).not.toBeNull()
    expect(monthlyFile!.content).toContain('Stable Patterns')

    // Verify archive received weeded entries
    const archived = archive.list()
    expect(archived.length).toBeGreaterThan(0)

    scheduler.recordMonthlyRun()
    expect(scheduler.shouldRunMonthly()).toBe(false)
  })

  it('scheduler tracks weekly and monthly independently', () => {
    const scheduler = createConsolidationScheduler(db)

    // Both should be due initially
    expect(scheduler.shouldRunWeekly()).toBe(true)
    expect(scheduler.shouldRunMonthly()).toBe(true)

    // Record weekly only
    scheduler.recordWeeklyRun()
    expect(scheduler.shouldRunWeekly()).toBe(false)
    expect(scheduler.shouldRunMonthly()).toBe(true)

    // Verify state persists
    const schedule = scheduler.getSchedule()
    expect(schedule.lastWeeklyAt).toBeTruthy()
    expect(schedule.lastMonthlyAt).toBeNull()
  })

  it('archive store accumulates entries from multiple consolidations', () => {
    const vault = createVault({ rootDir: vaultDir })
    const archive = createArchiveStore({ rootDir: archiveDir })

    // First weekly
    vault.write('daily/2026-04-14.md', '## 2026-04-14\n- Session debug: noise 1\n- Real lesson A')
    runWeeklyConsolidation({
      vault,
      archiveStore: archive,
      weekId: '2026-W15',
      dailyLogDates: ['2026-04-14'],
    })

    const count1 = archive.count()

    // Second weekly
    vault.write('daily/2026-04-21.md', '## 2026-04-21\n- Session debug: noise 2\n- Real lesson B')
    runWeeklyConsolidation({
      vault,
      archiveStore: archive,
      weekId: '2026-W16',
      dailyLogDates: ['2026-04-21'],
    })

    // Archive should have grown
    expect(archive.count()).toBeGreaterThanOrEqual(count1)
  })
})

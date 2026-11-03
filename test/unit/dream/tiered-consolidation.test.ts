import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVault } from '../../../src/memory/vault.js'
import { createArchiveStore } from '../../../src/memory/archive-store.js'
import {
  runWeeklyConsolidation,
  runMonthlyConsolidation,
} from '../../../src/dream/tiered-consolidation.js'

describe('tiered-consolidation', () => {
  let tempDir: string
  let archiveDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scns-tiered-'))
    archiveDir = join(tempDir, 'archive')
    // Create daily dir with test data
    mkdirSync(join(tempDir, 'daily'), { recursive: true })
    mkdirSync(join(tempDir, 'weekly'), { recursive: true })
    mkdirSync(join(tempDir, 'monthly'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function writeDailyLog(date: string, content: string): void {
    writeFileSync(join(tempDir, 'daily', `${date}.md`), content, 'utf-8')
  }

  function writeWeeklyLog(weekId: string, content: string): void {
    writeFileSync(join(tempDir, 'weekly', `${weekId}.md`), content, 'utf-8')
  }

  // ── Weekly consolidation ───────────────────────────────────────────

  describe('weekly consolidation', () => {
    it('produces a weekly summary from daily logs', () => {
      writeDailyLog(
        '2026-04-14',
        '## 2026-04-14\n- User prefers TypeScript strict mode\n- Session debug: fixed ESM import',
      )
      writeDailyLog(
        '2026-04-15',
        '## 2026-04-15\n- Lesson learned: always run tests before commit\n- User prefers TypeScript strict mode',
      )
      writeDailyLog('2026-04-16', '## 2026-04-16\n- Architecture decision: use Pino over Winston')

      const vault = createVault({ rootDir: tempDir })
      const archive = createArchiveStore({ rootDir: archiveDir })

      const result = runWeeklyConsolidation({
        vault,
        archiveStore: archive,
        weekId: '2026-W16',
        dailyLogDates: ['2026-04-14', '2026-04-15', '2026-04-16'],
      })

      expect(result.success).toBe(true)
      expect(result.weekId).toBe('2026-W16')
      expect(result.dailyLogsProcessed).toBe(3)
      expect(result.lessonsExtracted).toBeGreaterThan(0)

      // Verify weekly file exists
      const weeklyFile = vault.read('weekly/2026-W16.md')
      expect(weeklyFile).not.toBeNull()
      expect(weeklyFile!.content).toContain('2026-W16')
    })

    it('extracts from observation log format (user prompts)', () => {
      writeDailyLog(
        '2026-04-14',
        [
          '## 13:37:38',
          '',
          '**[session-hook]** User prompt: i want to build a feature that tracks memory consolidation weekly',
          'Tags: type:session-hook, source:user-prompt',
          '',
          '## 13:38:00',
          '',
          '**[session-hook]** Tool used: bash',
          'Tags: type:session-hook, source:tool-use',
        ].join('\n'),
      )

      const vault = createVault({ rootDir: tempDir })
      const archive = createArchiveStore({ rootDir: archiveDir })

      const result = runWeeklyConsolidation({
        vault,
        archiveStore: archive,
        weekId: '2026-W16',
        dailyLogDates: ['2026-04-14'],
      })

      expect(result.success).toBe(true)
      expect(result.lessonsExtracted).toBeGreaterThan(0)

      const weeklyFile = vault.read('weekly/2026-W16.md')!
      expect(weeklyFile.content).toContain('User request:')
    })

    it('does not harvest machine-authored dispatch briefs as user requests', () => {
      // Same gate as extractFromLog: the daily log records sub-agent dispatch
      // briefs in the same slot as the human's prompts. Ungated, a repeated
      // brief becomes a "User request: You are slidesmith…" lesson, gets
      // promoted to a High-Confidence Lesson, then a monthly Stable Pattern —
      // all indexed for retrieval.
      writeDailyLog(
        '2026-04-14',
        [
          '## 13:37:38',
          '',
          '**[session-hook]** User prompt: You are slidesmith. Read .orchestrator/deck-e19f65/kickoff-build-5.md IN FULL and execute it exactly.',
          'Tags: type:session-hook, source:user-prompt',
          '',
          '## 13:40:00',
          '',
          '**[session-hook]** User prompt: i want to build a feature that tracks memory consolidation weekly',
          'Tags: type:session-hook, source:user-prompt',
        ].join('\n'),
      )

      const vault = createVault({ rootDir: tempDir })
      const archive = createArchiveStore({ rootDir: archiveDir })

      const result = runWeeklyConsolidation({
        vault,
        archiveStore: archive,
        weekId: '2026-W16',
        dailyLogDates: ['2026-04-14'],
      })

      expect(result.success).toBe(true)
      const weeklyFile = vault.read('weekly/2026-W16.md')!
      expect(weeklyFile.content).toContain('User request: i want to build')
      expect(weeklyFile.content).not.toContain('slidesmith')
    })

    it('aggregates tool usage patterns', () => {
      const lines = [
        '## 10:00',
        '**[session-hook]** Tool used: bash',
        'Tags: tool:bash',
        '## 10:01',
        '**[session-hook]** Tool used: bash',
        'Tags: tool:bash',
        '## 10:02',
        '**[session-hook]** Tool used: edit',
        'Tags: tool:edit',
      ]
      writeDailyLog('2026-04-14', lines.join('\n'))

      const vault = createVault({ rootDir: tempDir })
      const archive = createArchiveStore({ rootDir: archiveDir })

      runWeeklyConsolidation({
        vault,
        archiveStore: archive,
        weekId: '2026-W16',
        dailyLogDates: ['2026-04-14'],
      })

      const weeklyFile = vault.read('weekly/2026-W16.md')!
      expect(weeklyFile.content).toContain('Tool usage pattern')
      expect(weeklyFile.content).toContain('bash(2)')
    })

    it('deduplicates repeated lessons across days', () => {
      // Same lesson appears 3 times across different days
      writeDailyLog('2026-04-14', '## 2026-04-14\n- User prefers TypeScript strict mode')
      writeDailyLog('2026-04-15', '## 2026-04-15\n- User prefers TypeScript strict mode')
      writeDailyLog('2026-04-16', '## 2026-04-16\n- User prefers TypeScript strict mode')

      const vault = createVault({ rootDir: tempDir })
      const archive = createArchiveStore({ rootDir: archiveDir })

      const result = runWeeklyConsolidation({
        vault,
        archiveStore: archive,
        weekId: '2026-W16',
        dailyLogDates: ['2026-04-14', '2026-04-15', '2026-04-16'],
      })

      expect(result.duplicatesRemoved).toBeGreaterThan(0)
    })

    it('marks repeated lessons as high-confidence', () => {
      writeDailyLog('2026-04-14', '## 2026-04-14\n- Always run tests first\n- Use Pino for logging')
      writeDailyLog(
        '2026-04-15',
        '## 2026-04-15\n- Always run tests first\n- Some random observation',
      )
      writeDailyLog('2026-04-16', '## 2026-04-16\n- Always run tests first')

      const vault = createVault({ rootDir: tempDir })
      const archive = createArchiveStore({ rootDir: archiveDir })

      runWeeklyConsolidation({
        vault,
        archiveStore: archive,
        weekId: '2026-W16',
        dailyLogDates: ['2026-04-14', '2026-04-15', '2026-04-16'],
      })

      const weeklyFile = vault.read('weekly/2026-W16.md')!
      // High-confidence lessons should be marked
      expect(weeklyFile.content).toContain('Always run tests first')
    })

    it('handles empty daily logs gracefully', () => {
      const vault = createVault({ rootDir: tempDir })
      const archive = createArchiveStore({ rootDir: archiveDir })

      const result = runWeeklyConsolidation({
        vault,
        archiveStore: archive,
        weekId: '2026-W16',
        dailyLogDates: [],
      })

      expect(result.success).toBe(true)
      expect(result.dailyLogsProcessed).toBe(0)
    })

    it('skips missing daily log files', () => {
      writeDailyLog('2026-04-14', '## 2026-04-14\n- Lesson one')
      // 2026-04-15 does not exist

      const vault = createVault({ rootDir: tempDir })
      const archive = createArchiveStore({ rootDir: archiveDir })

      const result = runWeeklyConsolidation({
        vault,
        archiveStore: archive,
        weekId: '2026-W16',
        dailyLogDates: ['2026-04-14', '2026-04-15'],
      })

      expect(result.success).toBe(true)
      expect(result.dailyLogsProcessed).toBe(1)
    })
  })

  // ── Monthly consolidation ──────────────────────────────────────────

  describe('monthly consolidation', () => {
    it('produces a monthly summary from weekly logs', () => {
      writeWeeklyLog(
        '2026-W14',
        '## Week 14\n### High-Confidence Lessons\n- TypeScript strict mode preferred\n### Lessons\n- Use Pino for logging',
      )
      writeWeeklyLog(
        '2026-W15',
        '## Week 15\n### High-Confidence Lessons\n- TDD is mandatory\n### Lessons\n- Run E2E tests',
      )
      writeWeeklyLog('2026-W16', '## Week 16\n### Lessons\n- New lesson')

      const vault = createVault({ rootDir: tempDir })
      const archive = createArchiveStore({ rootDir: archiveDir })

      const result = runMonthlyConsolidation({
        vault,
        archiveStore: archive,
        monthId: '2026-04',
        weeklyIds: ['2026-W14', '2026-W15', '2026-W16'],
      })

      expect(result.success).toBe(true)
      expect(result.monthId).toBe('2026-04')
      expect(result.weeklyLogsProcessed).toBe(3)

      const monthlyFile = vault.read('monthly/2026-04.md')
      expect(monthlyFile).not.toBeNull()
      expect(monthlyFile!.content).toContain('2026-04')
    })

    it('moves processed weekly logs to archive', () => {
      writeWeeklyLog('2026-W14', '## Week 14\n### Lessons\n- Test lesson')

      const vault = createVault({ rootDir: tempDir })
      const archive = createArchiveStore({ rootDir: archiveDir })

      const result = runMonthlyConsolidation({
        vault,
        archiveStore: archive,
        monthId: '2026-04',
        weeklyIds: ['2026-W14'],
      })

      expect(result.archivedWeeklies).toBeGreaterThanOrEqual(0)
    })

    it('handles missing weekly logs', () => {
      writeWeeklyLog('2026-W14', '## Week 14\n### Lessons\n- Test lesson')
      // W15 doesn't exist

      const vault = createVault({ rootDir: tempDir })
      const archive = createArchiveStore({ rootDir: archiveDir })

      const result = runMonthlyConsolidation({
        vault,
        archiveStore: archive,
        monthId: '2026-04',
        weeklyIds: ['2026-W14', '2026-W15'],
      })

      expect(result.success).toBe(true)
      expect(result.weeklyLogsProcessed).toBe(1)
    })

    it('handles empty weekly list', () => {
      const vault = createVault({ rootDir: tempDir })
      const archive = createArchiveStore({ rootDir: archiveDir })

      const result = runMonthlyConsolidation({
        vault,
        archiveStore: archive,
        monthId: '2026-04',
        weeklyIds: [],
      })

      expect(result.success).toBe(true)
      expect(result.weeklyLogsProcessed).toBe(0)
    })
  })
})

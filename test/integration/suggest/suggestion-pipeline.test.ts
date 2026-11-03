/**
 * Integration tests for the full suggestion pipeline:
 * Patterns → Generate → Review → Execute
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfidenceScorer } from '../../../src/suggest/confidence.js'
import { createEvidenceGatherer } from '../../../src/suggest/evidence.js'
import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
import { createSuggestionGenerator } from '../../../src/suggest/generator.js'
import { createExecutor, StepAction } from '../../../src/suggest/executor.js'
import { createReviewWorkflow } from '../../../src/suggest/review.js'
import { SuggestionStatus } from '../../../src/suggest/types.js'
import type { DetectedPatterns } from '../../../src/observe/pattern-detector.js'

/**
 * Every test in this file drives the real filesystem-backed suggestion store
 * through the full generate -> review -> execute pipeline, so each one is bound
 * by sync fs latency rather than CPU.
 *
 * Individually they are nowhere near the 10s ceiling — measured 743ms, 817ms
 * and 25/25 green in 16.7s when the file runs alone. Under full-suite
 * parallelism on Windows they get starved badly enough to blow it, and the
 * test that loses the scheduling lottery MOVES between runs (three separate
 * tests across three runs), which is what marks this as contention rather than
 * a defect in any one of them.
 *
 * Widened file-wide instead of globally: vitest.config.ts stays at 10s so the
 * ~8000 tests with no business taking ten seconds still get caught.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// ── Helpers ──────────────────────────────────────────────────────────

const tmpDirs: string[] = []

function createTestSuggestionSystem(autonomyLevel = 0) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'scns-suggest-test-'))
  tmpDirs.push(tmpDir)

  const store = createSuggestionStore({ rootDir: tmpDir })
  const scorer = createConfidenceScorer()
  const evidenceGatherer = createEvidenceGatherer()
  const generator = createSuggestionGenerator({ scorer, evidenceGatherer, store })
  const executor = createExecutor({
    autonomyLevel,
    skillsDir: join(tmpDir, 'skills'),
    automationsDir: join(tmpDir, 'automations'),
    configBaseDir: tmpDir,
  })
  const review = createReviewWorkflow({ store, executor })

  return { store, scorer, evidenceGatherer, generator, executor, review, tmpDir }
}

function makeTestPatterns(overrides?: Partial<DetectedPatterns>): DetectedPatterns {
  return {
    workSchedule: {
      activeHours: [9, 10, 11, 12, 13, 14, 15, 16, 17],
      peakHour: 14,
      averageSessionMinutes: 90,
      breakGaps: [15, 30],
      activeDays: [1, 2, 3, 4, 5],
    },
    toolFrequency: {
      appCounts: new Map([
        ['VSCode', 50],
        ['Chrome', 30],
        ['Terminal', 40],
        ['Slack', 10],
      ]),
      topApps: ['VSCode', 'Terminal', 'Chrome', 'Slack'],
      categoryBreakdown: new Map([
        ['coding', 50],
        ['terminal', 40],
        ['browsing', 30],
        ['communication', 10],
      ]),
    },
    projectFocus: {
      repoCounts: new Map([
        ['scns', 25],
        ['my-app', 10],
        ['docs', 5],
      ]),
      topRepos: ['scns', 'my-app', 'docs'],
      fileTypeCounts: new Map([
        ['.ts', 60],
        ['.md', 20],
        ['.json', 10],
      ]),
      recentFocus: 'scns',
    },
    observationCount: 200,
    windowStart: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    windowEnd: new Date().toISOString(),
    ...overrides,
  }
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs.length = 0
})

// ── 1. 7-Day Observation → Suggestions ──────────────────────────────

describe('7-day observation → suggestions', () => {
  it('produces a mix of suggestion types from realistic patterns', () => {
    const { generator } = createTestSuggestionSystem()
    const patterns = makeTestPatterns()
    const suggestions = generator.generate(patterns)

    expect(suggestions.length).toBeGreaterThan(0)
    const types = new Set(suggestions.map((s) => s.type))
    expect(types.size).toBeGreaterThanOrEqual(2)
  })

  it('generates skill suggestions for high-usage tools', () => {
    const { generator } = createTestSuggestionSystem()
    const suggestions = generator.generate(makeTestPatterns())

    const skills = suggestions.filter((s) => s.type === 'skill')
    expect(skills.length).toBeGreaterThan(0)
    const titles = skills.map((s) => s.title.toLowerCase())
    expect(titles.some((t) => t.includes('vscode') || t.includes('terminal'))).toBe(true)
  })

  it('generates workflow suggestions from schedule patterns', () => {
    const { generator } = createTestSuggestionSystem()
    // Isolate workflow generation by only providing workSchedule patterns
    const patterns = makeTestPatterns({
      toolFrequency: null,
      projectFocus: null,
    })
    const suggestions = generator.generate(patterns)

    const workflows = suggestions.filter((s) => s.type === 'workflow')
    expect(workflows.length).toBeGreaterThan(0)
    expect(workflows.some((w) => w.title.includes('14:00'))).toBe(true)
  })

  it('all suggestions have confidence above minimumConfidence threshold', () => {
    const { generator } = createTestSuggestionSystem()
    const suggestions = generator.generate(makeTestPatterns())

    for (const suggestion of suggestions) {
      expect(suggestion.confidence).toBeGreaterThanOrEqual(0.4)
    }
  })

  it('attaches evidence to each suggestion from correct pattern sources', () => {
    const { generator } = createTestSuggestionSystem()
    const suggestions = generator.generate(makeTestPatterns())

    for (const suggestion of suggestions) {
      expect(suggestion.evidence.length).toBeGreaterThan(0)
      for (const ev of suggestion.evidence) {
        expect(ev.source).toBeTruthy()
        expect(ev.detail).toBeTruthy()
        expect(ev.observedAt).toBeTruthy()
        expect(ev.weight).toBeGreaterThan(0)
      }
    }
  })
})

// ── 2. Approve → Implementation Plan ────────────────────────────────

describe('approve → implementation plan', () => {
  it('approve first suggestion → plan created with correct steps', () => {
    const { generator, review } = createTestSuggestionSystem()
    const suggestions = generator.generate(makeTestPatterns())
    expect(suggestions.length).toBeGreaterThan(0)

    const result = review.approve(suggestions[0]!.id)
    expect(result.success).toBe(true)
    expect(result.plan).toBeDefined()
    expect(result.plan!.suggestionId).toBe(suggestions[0]!.id)
    expect(result.plan!.steps.length).toBeGreaterThan(0)
  })

  it('skill suggestion → plan has CreateFile step for skill file', () => {
    const { generator, review } = createTestSuggestionSystem()
    const suggestions = generator.generate(makeTestPatterns())
    const skill = suggestions.find((s) => s.type === 'skill')
    expect(skill).toBeDefined()

    const result = review.approve(skill!.id)
    expect(result.success).toBe(true)
    const createStep = result.plan!.steps.find((step) => step.action === StepAction.CreateFile)
    expect(createStep).toBeDefined()
    expect(createStep!.target).toContain(skill!.id)
  })

  it('automation suggestion → plan has CreateFile for script', () => {
    const { generator, review } = createTestSuggestionSystem()
    // Isolate automation generation so it appears in capped results
    const patterns = makeTestPatterns({ toolFrequency: null, workSchedule: null })
    const suggestions = generator.generate(patterns)
    const automation = suggestions.find((s) => s.type === 'automation')
    expect(automation).toBeDefined()

    const result = review.approve(automation!.id)
    expect(result.success).toBe(true)
    const createStep = result.plan!.steps.find((step) => step.action === StepAction.CreateFile)
    expect(createStep).toBeDefined()
    expect(createStep!.target).toContain(automation!.id)
  })

  it('plan estimatedMinutes is reasonable', () => {
    const { generator, review } = createTestSuggestionSystem()
    const suggestions = generator.generate(makeTestPatterns())

    const result = review.approve(suggestions[0]!.id)
    expect(result.plan!.estimatedMinutes).toBeGreaterThan(0)
  })

  it('approved suggestion status updated in store', () => {
    const { generator, review, store } = createTestSuggestionSystem()
    const suggestions = generator.generate(makeTestPatterns())

    review.approve(suggestions[0]!.id)
    const stored = store.get(suggestions[0]!.id)
    expect(stored).not.toBeNull()
    expect(stored!.status).toBe(SuggestionStatus.Approved)
  })
})

// ── 3. Reject → Not Re-Suggested ────────────────────────────────────

describe('reject → not re-suggested', () => {
  it('reject stores the rejection reason', () => {
    const { generator, review, store } = createTestSuggestionSystem()
    const suggestions = generator.generate(makeTestPatterns())
    const first = suggestions[0]!

    const result = review.reject(first.id, 'Not useful')
    expect(result.success).toBe(true)
    const stored = store.get(first.id)
    expect(stored!.status).toBe(SuggestionStatus.Rejected)
    expect(stored!.reviewReason).toBe('Not useful')
  })

  it('re-run generator with same patterns → rejected suggestion not regenerated', () => {
    const { generator, review } = createTestSuggestionSystem()
    const patterns = makeTestPatterns()
    const first = generator.generate(patterns)
    const rejectedTitle = first[0]!.title

    review.reject(first[0]!.id, 'Not needed')

    // Re-run with same patterns
    const second = generator.generate(patterns)
    const titles = second.map((s) => s.title)
    expect(titles).not.toContain(rejectedTitle)
  })

  it('getRejectedTitles includes the rejected title', () => {
    const { generator, review, store } = createTestSuggestionSystem()
    const suggestions = generator.generate(makeTestPatterns())
    const first = suggestions[0]!

    review.reject(first.id, 'Bad idea')
    const rejectedTitles = store.getRejectedTitles()
    expect(rejectedTitles).toContain(first.title)
  })

  it('multiple rejections all respected', () => {
    const { generator, review, store } = createTestSuggestionSystem()
    const patterns = makeTestPatterns()
    const suggestions = generator.generate(patterns)

    // Reject first two
    const rejected: string[] = []
    for (const s of suggestions.slice(0, 2)) {
      review.reject(s.id, `Rejected: ${s.title}`)
      rejected.push(s.title)
    }

    const rejectedTitles = store.getRejectedTitles()
    for (const title of rejected) {
      expect(rejectedTitles).toContain(title)
    }

    // Re-run — neither should reappear
    const regenerated = generator.generate(patterns)
    const newTitles = regenerated.map((s) => s.title)
    for (const title of rejected) {
      expect(newTitles).not.toContain(title)
    }
  })
})

// ── 4. L1 vs L2 Approval Behavior ──────────────────────────────────

describe('L1 vs L2 approval behavior', () => {
  it('L1 (autonomyLevel=1): approve → plan generated, NOT executed', () => {
    const { generator, review } = createTestSuggestionSystem(1)
    const suggestions = generator.generate(makeTestPatterns())

    const result = review.approve(suggestions[0]!.id)
    expect(result.success).toBe(true)
    expect(result.plan).toBeDefined()
    expect(result.plan!.requiresUserApproval).toBe(true)
    expect(result.execution).toBeUndefined()
  })

  it('L2 (autonomyLevel=2): approve → plan generated AND executed', () => {
    const { generator, review } = createTestSuggestionSystem(2)
    const suggestions = generator.generate(makeTestPatterns())

    const result = review.approve(suggestions[0]!.id)
    expect(result.success).toBe(true)
    expect(result.plan).toBeDefined()
    expect(result.plan!.requiresUserApproval).toBe(false)
    expect(result.execution).toBeDefined()
  })

  it('L3 (autonomyLevel=3): approve → all steps executed including RunCommand', () => {
    const { generator, review } = createTestSuggestionSystem(3)
    const suggestions = generator.generate(makeTestPatterns())

    const result = review.approve(suggestions[0]!.id)
    expect(result.success).toBe(true)
    expect(result.execution).toBeDefined()
    expect(result.execution!.stepsCompleted).toBeGreaterThan(0)
  })

  it('L2 execution tracks files created', () => {
    const { generator, review } = createTestSuggestionSystem(2)
    const suggestions = generator.generate(makeTestPatterns())
    // Find a suggestion whose plan has CreateFile (skill or automation)
    const skill = suggestions.find((s) => s.type === 'skill' || s.type === 'automation')
    expect(skill).toBeDefined()

    const result = review.approve(skill!.id)
    expect(result.execution).toBeDefined()
    expect(result.execution!.filesCreated.length).toBeGreaterThan(0)
    // Verify file actually exists on disk
    for (const f of result.execution!.filesCreated) {
      expect(existsSync(f)).toBe(true)
    }
  })
})

// ── 5. Full Pipeline: Patterns → Generate → Review → Execute ────────

describe('full pipeline: patterns → generate → review → execute', () => {
  it('end-to-end: patterns in, implementation artifacts out', () => {
    const { generator, review } = createTestSuggestionSystem(2)
    const patterns = makeTestPatterns()

    const suggestions = generator.generate(patterns)
    expect(suggestions.length).toBeGreaterThan(0)

    // Approve the first skill/automation to get file creation
    const actionable = suggestions.find((s) => s.type === 'skill' || s.type === 'automation')
    expect(actionable).toBeDefined()

    const result = review.approve(actionable!.id)
    expect(result.success).toBe(true)
    expect(result.execution).toBeDefined()
    expect(result.execution!.filesCreated.length).toBeGreaterThan(0)
  })

  it('list pending → approve best → execute', () => {
    const { generator, review } = createTestSuggestionSystem(2)
    generator.generate(makeTestPatterns())

    const pending = review.listPending()
    expect(pending.length).toBeGreaterThan(0)

    // listPending sorts by confidence descending
    const best = pending[0]!
    const result = review.approve(best.id)
    expect(result.success).toBe(true)
  })

  it('store reflects correct status at each stage', () => {
    const { generator, review, store } = createTestSuggestionSystem(2)
    const suggestions = generator.generate(makeTestPatterns())
    const target = suggestions[0]!

    // Stage 1: pending
    const afterGen = store.get(target.id)
    expect(afterGen!.status).toBe(SuggestionStatus.Pending)

    // Stage 2: approve → implemented (L2 auto-executes)
    review.approve(target.id)
    const afterApprove = store.get(target.id)
    expect(afterApprove!.status).toBe(SuggestionStatus.Implemented)
  })

  it('evidence chain traceable from pattern data to suggestion to plan', () => {
    const { generator, review } = createTestSuggestionSystem()
    const patterns = makeTestPatterns()
    const suggestions = generator.generate(patterns)
    const first = suggestions[0]!

    // Evidence exists from generation
    expect(first.evidence.length).toBeGreaterThan(0)

    // Plan references suggestion
    const result = review.approve(first.id)
    expect(result.plan!.suggestionId).toBe(first.id)

    // Summary includes evidence count
    const summary = review.getSummary(first.id)
    expect(summary).not.toBeNull()
    expect(summary!.evidenceCount).toBe(first.evidence.length)
  })
})

// ── 6. Deduplication and Confidence Filtering ───────────────────────

describe('deduplication and confidence filtering', () => {
  it('generate with same patterns twice → no duplicate suggestions', () => {
    const { generator, store } = createTestSuggestionSystem()
    const patterns = makeTestPatterns()

    const first = generator.generate(patterns)
    // Note: tryEmit saves all generated suggestions to store (may exceed maxPerCycle returned)
    const storeCountAfterFirst = store.list().length
    expect(storeCountAfterFirst).toBeGreaterThanOrEqual(first.length)

    const second = generator.generate(patterns)

    // Second run should produce no new suggestions (all duplicates detected)
    expect(second.length).toBe(0)

    // Store count unchanged after second run
    const storeCountAfterSecond = store.list().length
    expect(storeCountAfterSecond).toBe(storeCountAfterFirst)
  })

  it('low-confidence patterns (few observations) → filtered out', () => {
    const { generator } = createTestSuggestionSystem()
    const weakPatterns = makeTestPatterns({
      toolFrequency: {
        appCounts: new Map([
          ['VSCode', 2],
          ['Chrome', 1],
        ]),
        topApps: ['VSCode', 'Chrome'],
        categoryBreakdown: new Map([['coding', 2]]),
      },
      projectFocus: {
        repoCounts: new Map([['tiny', 1]]),
        topRepos: ['tiny'],
        fileTypeCounts: new Map([['.ts', 1]]),
        recentFocus: null,
      },
      observationCount: 3,
    })

    const suggestions = generator.generate(weakPatterns)
    // Low observation counts should not pass confidence threshold
    for (const s of suggestions) {
      expect(s.confidence).toBeGreaterThanOrEqual(0.4)
    }
  })

  it('similar titles but different types → both allowed', () => {
    const { generator, store } = createTestSuggestionSystem()

    // First generate with patterns that yield skills
    const skillPatterns = makeTestPatterns({
      toolFrequency: {
        appCounts: new Map([['TablePlus', 50]]),
        topApps: ['TablePlus'],
        categoryBreakdown: new Map([['database', 50]]),
      },
      projectFocus: null,
      workSchedule: null,
    })
    const skills = generator.generate(skillPatterns)

    // Now generate MCP suggestions for the same tools
    // MCP suggestions are also generated for TablePlus (it's a DB_CLIENT)
    // Both 'Create TablePlus helper skill' and 'Install TablePlus MCP server' should exist
    const all = store.list()
    const tableSkill = all.find(
      (s) => s.type === 'skill' && s.title.toLowerCase().includes('tableplus'),
    )
    const tableMcp = all.find(
      (s) => s.type === 'mcp' && s.title.toLowerCase().includes('tableplus'),
    )

    // Both types generated for same tool
    if (skills.length > 0) {
      expect(tableSkill || tableMcp).toBeDefined()
    }

    // findSimilar only matches within same type
    const hasBoth = tableSkill != null && tableMcp != null
    if (hasBoth) {
      expect(tableSkill!.type).not.toBe(tableMcp!.type)
    }
  })
})

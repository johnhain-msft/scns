import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSuggestionGenerator } from '../../../src/suggest/generator.js'
import { createConfidenceScorer } from '../../../src/suggest/confidence.js'
import { createEvidenceGatherer } from '../../../src/suggest/evidence.js'
import type { Suggestion, SuggestionType } from '../../../src/suggest/types.js'
import type {
  ToolFrequencyPattern,
  WorkSchedulePattern,
  ProjectFocusPattern,
  DetectedPatterns,
} from '../../../src/observe/pattern-detector.js'
import type { ExtractedPatterns } from '../../../src/otel/pattern-extractor.js'

// ── In-memory mock store ───────────────────────────────────────────

function createMockStore() {
  const suggestions = new Map<string, Suggestion>()

  return {
    save(suggestion: Suggestion): void {
      suggestions.set(suggestion.id, suggestion)
    },
    get(id: string): Suggestion | null {
      return suggestions.get(id) ?? null
    },
    list(status?: string): readonly Suggestion[] {
      const all = [...suggestions.values()]
      return status ? all.filter((s) => s.status === status) : all
    },
    updateStatus(id: string, newStatus: string, _reason?: string): Suggestion | null {
      const s = suggestions.get(id)
      if (!s) return null
      const updated = { ...s, status: newStatus, updatedAt: new Date().toISOString() }
      suggestions.set(id, updated)
      return updated
    },
    findSimilar(title: string, type: SuggestionType): Suggestion | null {
      const titleWords = new Set(
        title
          .toLowerCase()
          .replace(/[^\w\s]/g, '')
          .split(/\s+/)
          .filter((w) => w.length > 0),
      )
      for (const s of suggestions.values()) {
        if (s.type !== type) continue
        const existingWords = new Set(
          s.title
            .toLowerCase()
            .replace(/[^\w\s]/g, '')
            .split(/\s+/)
            .filter((w) => w.length > 0),
        )
        let intersection = 0
        for (const w of titleWords) {
          if (existingWords.has(w)) intersection++
        }
        const union = new Set([...titleWords, ...existingWords]).size
        if (union > 0 && intersection / union > 0.8) return s
      }
      return null
    },
    getRejectedTitles(): readonly string[] {
      return [...suggestions.values()].filter((s) => s.status === 'rejected').map((s) => s.title)
    },
    remove(id: string): boolean {
      return suggestions.delete(id)
    },
    // Test-only helpers
    _size(): number {
      return suggestions.size
    },
    _clear(): void {
      suggestions.clear()
    },
  }
}

// ── Pattern factories ──────────────────────────────────────────────

function makeToolPattern(overrides?: Partial<ToolFrequencyPattern>): ToolFrequencyPattern {
  return {
    appCounts: new Map([
      ['VSCode', 50],
      ['Chrome', 30],
      ['Terminal', 25],
    ]),
    topApps: ['VSCode', 'Chrome', 'Terminal'],
    categoryBreakdown: new Map([
      ['coding', 50],
      ['browsing', 30],
      ['terminal', 25],
    ]),
    ...overrides,
  }
}

function makeSchedulePattern(overrides?: Partial<WorkSchedulePattern>): WorkSchedulePattern {
  return {
    activeHours: [9, 10, 11, 14, 15, 16],
    peakHour: 10,
    averageSessionMinutes: 150,
    breakGaps: [15, 30, 60],
    activeDays: [1, 2, 3, 4, 5],
    ...overrides,
  }
}

function makeProjectPattern(overrides?: Partial<ProjectFocusPattern>): ProjectFocusPattern {
  return {
    repoCounts: new Map([
      ['scns', 30],
      ['dotfiles', 5],
    ]),
    topRepos: ['scns', 'dotfiles'],
    fileTypeCounts: new Map([
      ['ts', 50],
      ['json', 10],
    ]),
    recentFocus: 'scns',
    repoActivityCounts: new Map([
      ['scns', 80],
      ['dotfiles', 6],
    ]),
    ...overrides,
  }
}

function makeDetectedPatterns(overrides?: Partial<DetectedPatterns>): DetectedPatterns {
  return {
    workSchedule: makeSchedulePattern(),
    toolFrequency: makeToolPattern(),
    projectFocus: makeProjectPattern(),
    observationCount: 200,
    windowStart: '2025-01-01T00:00:00.000Z',
    windowEnd: '2025-01-07T23:59:59.000Z',
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('createSuggestionGenerator', () => {
  let store: ReturnType<typeof createMockStore>
  let generator: ReturnType<typeof createSuggestionGenerator>
  // Linting proposals are suppressed for extensions the repo already lints, so these cases need a
  // tree with NO linter configured. Explicit rather than inherited from `process.cwd()`, which is
  // the scns repo itself — ESLint is committed there, and `ts`/`js` cases would be correctly
  // suppressed for a reason that has nothing to do with what they assert.
  let repoDir: string

  beforeEach(() => {
    store = createMockStore()
    repoDir = mkdtempSync(join(tmpdir(), 'scns-generator-no-lint-'))
    generator = createSuggestionGenerator(
      {
        scorer: createConfidenceScorer(),
        evidenceGatherer: createEvidenceGatherer(),
        store,
      },
      { minimumConfidence: 0.3, repoDir },
    )
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  // ── Skill Suggestions ────────────────────────────────────────────

  describe('generateSkillSuggestions', () => {
    it('generates skill suggestion for high-usage IDE app', () => {
      const pattern = makeToolPattern({
        appCounts: new Map([['VSCode', 50]]),
        topApps: ['VSCode'],
        categoryBreakdown: new Map([['coding', 50]]),
      })
      const suggestions = generator.generateSkillSuggestions(pattern, 7)
      expect(suggestions.length).toBeGreaterThan(0)
      expect(suggestions.some((s) => s.title.includes('VSCode'))).toBe(true)
      expect(suggestions.every((s) => s.type === 'skill')).toBe(true)
    })

    it('generates skill suggestion for high-usage terminal tool', () => {
      const pattern = makeToolPattern({
        appCounts: new Map([['Terminal', 30]]),
        topApps: ['Terminal'],
        categoryBreakdown: new Map([['terminal', 30]]),
      })
      const suggestions = generator.generateSkillSuggestions(pattern, 7)
      expect(suggestions.length).toBeGreaterThan(0)
      expect(suggestions.some((s) => s.title.includes('Terminal'))).toBe(true)
    })

    it('does not suggest for low-usage app (count <= 20)', () => {
      const pattern = makeToolPattern({
        appCounts: new Map([['Niche', 5]]),
        topApps: ['Niche'],
        categoryBreakdown: new Map([['other', 5]]),
      })
      const suggestions = generator.generateSkillSuggestions(pattern, 7)
      expect(suggestions).toHaveLength(0)
    })

    it('formats title as "Create {app} workflow skill" for IDEs', () => {
      const pattern = makeToolPattern({
        appCounts: new Map([['VSCode', 50]]),
        topApps: ['VSCode'],
        categoryBreakdown: new Map([['coding', 50]]),
      })
      const suggestions = generator.generateSkillSuggestions(pattern, 7)
      const match = suggestions.find((s) => s.title.includes('VSCode'))
      expect(match?.title).toBe('Create VSCode workflow skill')
    })

    it('formats title as "Create {app} helper skill" for terminal tools', () => {
      const localStore = createMockStore()
      const gen = createSuggestionGenerator(
        {
          scorer: createConfidenceScorer(),
          evidenceGatherer: createEvidenceGatherer(),
          store: localStore,
        },
        { minimumConfidence: 0.1 },
      )
      const pattern = makeToolPattern({
        appCounts: new Map([['Terminal', 30]]),
        topApps: ['Terminal'],
        categoryBreakdown: new Map([['terminal', 30]]),
      })
      const suggestions = gen.generateSkillSuggestions(pattern, 7)
      const match = suggestions.find((s) => s.title.includes('Terminal'))
      expect(match?.title).toBe('Create Terminal helper skill')
    })

    it('description includes usage count and window days', () => {
      const pattern = makeToolPattern({
        appCounts: new Map([['VSCode', 50]]),
        topApps: ['VSCode'],
        categoryBreakdown: new Map([['coding', 50]]),
      })
      const suggestions = generator.generateSkillSuggestions(pattern, 7)
      const match = suggestions.find((s) => s.title.includes('VSCode'))!
      expect(match.description).toContain('50')
      expect(match.description).toContain('7')
    })

    it('attaches evidence from tool frequency', () => {
      const pattern = makeToolPattern({
        appCounts: new Map([['VSCode', 50]]),
        topApps: ['VSCode'],
        categoryBreakdown: new Map([['coding', 50]]),
      })
      const suggestions = generator.generateSkillSuggestions(pattern, 7)
      const match = suggestions.find((s) => s.title.includes('VSCode'))!
      expect(match.evidence.length).toBeGreaterThan(0)
      expect(match.evidence.some((e) => e.source === 'tool-frequency')).toBe(true)
    })
  })

  // ── MCP Suggestions ──────────────────────────────────────────────

  describe('generateMcpSuggestions', () => {
    it('suggests MCP for database client usage', () => {
      const pattern = makeToolPattern({
        appCounts: new Map([['TablePlus', 30]]),
        topApps: ['TablePlus'],
        categoryBreakdown: new Map([['other', 30]]),
      })
      const suggestions = generator.generateMcpSuggestions(pattern, 7)
      expect(suggestions.length).toBeGreaterThan(0)
      expect(suggestions.every((s) => s.type === 'mcp')).toBe(true)
    })

    it('suggests MCP for cloud console usage', () => {
      const pattern = makeToolPattern({
        appCounts: new Map([['AWS Console', 25]]),
        topApps: ['AWS Console'],
        categoryBreakdown: new Map([['other', 25]]),
      })
      const suggestions = generator.generateMcpSuggestions(pattern, 7)
      expect(suggestions.length).toBeGreaterThan(0)
      expect(suggestions.some((s) => s.title.toLowerCase().includes('mcp'))).toBe(true)
    })

    it('suggests generic MCP integration for high-usage tools', () => {
      const pattern = makeToolPattern({
        appCounts: new Map([['Figma', 25]]),
        topApps: ['Figma'],
        categoryBreakdown: new Map([['other', 25]]),
      })
      const suggestions = generator.generateMcpSuggestions(pattern, 7)
      expect(suggestions.length).toBeGreaterThan(0)
    })
  })

  // ── Automation Suggestions ───────────────────────────────────────

  describe('generateAutomationSuggestions', () => {
    it('suggests build/deploy automation for high-commit repos', () => {
      const pattern = makeProjectPattern({
        repoCounts: new Map([['scns', 30]]),
        topRepos: ['scns'],
      })
      const suggestions = generator.generateAutomationSuggestions(pattern, 7)
      expect(suggestions.length).toBeGreaterThan(0)
      expect(suggestions.some((s) => s.title.includes('scns'))).toBe(true)
      expect(suggestions.every((s) => s.type === 'automation')).toBe(true)
    })

    it('suggests linting automation for dominant file types', () => {
      const pattern = makeProjectPattern({
        fileTypeCounts: new Map([
          ['ts', 80],
          ['json', 5],
        ]),
        topRepos: ['scns'],
        repoCounts: new Map([['scns', 10]]),
      })
      const suggestions = generator.generateAutomationSuggestions(pattern, 7)
      expect(suggestions.some((s) => s.title.toLowerCase().includes('ts'))).toBe(true)
    })

    it('suggests workflow for recent focus project', () => {
      const pattern = makeProjectPattern({ recentFocus: 'my-project' })
      const suggestions = generator.generateAutomationSuggestions(pattern, 7)
      expect(suggestions.some((s) => s.title.includes('my-project'))).toBe(true)
    })

    it('produces no suggestions when no git activity', () => {
      const pattern = makeProjectPattern({
        repoCounts: new Map(),
        topRepos: [],
        fileTypeCounts: new Map(),
        recentFocus: null,
      })
      const suggestions = generator.generateAutomationSuggestions(pattern, 7)
      expect(suggestions).toHaveLength(0)
    })
  })

  // ── Workflow Suggestions ─────────────────────────────────────────

  describe('generateWorkflowSuggestions', () => {
    it('suggests scheduling for consistent peak hours', () => {
      const schedule = makeSchedulePattern({ peakHour: 10 })
      const suggestions = generator.generateWorkflowSuggestions(schedule, 7)
      expect(suggestions.length).toBeGreaterThan(0)
      expect(suggestions.some((s) => s.title.includes('10:00'))).toBe(true)
      expect(suggestions.every((s) => s.type === 'workflow')).toBe(true)
    })

    it('suggests session rotation for long sessions (>240 min avg)', () => {
      const schedule = makeSchedulePattern({ averageSessionMinutes: 300 })
      const suggestions = generator.generateWorkflowSuggestions(schedule, 7)
      expect(suggestions.some((s) => s.title.toLowerCase().includes('rotation'))).toBe(true)
    })

    it('suggests break reminders when breaks detected', () => {
      const schedule = makeSchedulePattern({ breakGaps: [15, 20, 25] })
      const suggestions = generator.generateWorkflowSuggestions(schedule, 7)
      expect(suggestions.some((s) => s.title.toLowerCase().includes('break'))).toBe(true)
    })

    it('produces no suggestions when no schedule pattern', () => {
      const gen = createSuggestionGenerator(
        {
          scorer: createConfidenceScorer(),
          evidenceGatherer: createEvidenceGatherer(),
          store: createMockStore(),
        },
        { minimumConfidence: 0.3 },
      )
      const patterns = makeDetectedPatterns({ workSchedule: null })
      const all = gen.generate(patterns)
      expect(all.filter((s) => s.type === 'workflow')).toHaveLength(0)
    })
  })

  // ── Deduplication ────────────────────────────────────────────────

  describe('deduplication', () => {
    it('does not re-suggest duplicate title+type', () => {
      const pattern = makeToolPattern({
        appCounts: new Map([['VSCode', 50]]),
        topApps: ['VSCode'],
        categoryBreakdown: new Map([['coding', 50]]),
      })
      const first = generator.generateSkillSuggestions(pattern, 7)
      expect(first.length).toBeGreaterThan(0)
      // Second call should find existing and skip
      const second = generator.generateSkillSuggestions(pattern, 7)
      expect(second).toHaveLength(0)
    })

    it('does not suggest if title was previously rejected', () => {
      const pattern = makeToolPattern({
        appCounts: new Map([['VSCode', 50]]),
        topApps: ['VSCode'],
        categoryBreakdown: new Map([['coding', 50]]),
      })
      // Generate first, then reject it
      const first = generator.generateSkillSuggestions(pattern, 7)
      expect(first.length).toBeGreaterThan(0)
      store.updateStatus(first[0]!.id, 'rejected', 'not useful')
      store._clear()
      // Re-insert the rejected one manually so getRejectedTitles returns it
      store.save({ ...first[0]!, status: 'rejected' })

      const second = generator.generateSkillSuggestions(pattern, 7)
      expect(second).toHaveLength(0)
    })

    // John's requirement: an auto-rejected duplicate must not "pop up again". The dedup WINDOW
    // deliberately lets stale proposals resurface, so this proves the machine rejection outranks it.
    it('keeps a machine-rejected duplicate blocked even past the dedup window', () => {
      const windowed = createSuggestionGenerator(
        {
          scorer: createConfidenceScorer(),
          evidenceGatherer: createEvidenceGatherer(),
          store,
        },
        { minimumConfidence: 0.3, dedupWindowDays: 14 },
      )
      const pattern = makeToolPattern({
        appCounts: new Map([['VSCode', 50]]),
        topApps: ['VSCode'],
        categoryBreakdown: new Map([['coding', 50]]),
      })
      const first = windowed.generateSkillSuggestions(pattern, 7)
      expect(first.length).toBeGreaterThan(0)
      const long_ago = new Date(Date.now() - 100 * 86_400_000).toISOString()
      store._clear()
      store.save({
        ...first[0]!,
        status: 'rejected',
        reviewReason: 'duplicate-capability: the assistant already edits files natively',
        createdAt: long_ago,
        updatedAt: long_ago,
      })

      expect(windowed.generateSkillSuggestions(pattern, 7)).toHaveLength(0)
    })

    it('deduplicates similar but not identical titles via word overlap', () => {
      const pattern1 = makeToolPattern({
        appCounts: new Map([['VSCode', 50]]),
        topApps: ['VSCode'],
        categoryBreakdown: new Map([['coding', 50]]),
      })
      const first = generator.generateSkillSuggestions(pattern1, 7)
      expect(first.length).toBeGreaterThan(0)

      // A second call with same data should be deduped
      const second = generator.generateSkillSuggestions(pattern1, 7)
      expect(second).toHaveLength(0)
    })

    // Phase 13.2: template-family dedup (time-like suffix collapse)
    it('collapses "Schedule heavy tasks for HH:00" family across different hours', () => {
      const sched1 = makeSchedulePattern({ peakHour: 22 })
      const first = generator.generateWorkflowSuggestions(sched1, 7)
      const scheduleTitles = first.filter((s) => s.title.startsWith('Schedule heavy tasks for'))
      expect(scheduleTitles.length).toBe(1)

      // Different peak hour → same template family → should be deduped
      const sched2 = makeSchedulePattern({ peakHour: 3 })
      const second = generator.generateWorkflowSuggestions(sched2, 7)
      const secondSchedule = second.filter((s) => s.title.startsWith('Schedule heavy tasks for'))
      expect(secondSchedule.length).toBe(0)

      const sched3 = makeSchedulePattern({ peakHour: 14 })
      const third = generator.generateWorkflowSuggestions(sched3, 7)
      const thirdSchedule = third.filter((s) => s.title.startsWith('Schedule heavy tasks for'))
      expect(thirdSchedule.length).toBe(0)
    })
  })

  // ── Phase 13.2: actionable field on generated suggestions ────────

  describe('actionable field', () => {
    it('marks workflow scheduling suggestions as actionable=false', () => {
      const sched = makeSchedulePattern({ peakHour: 10 })
      const suggestions = generator.generateWorkflowSuggestions(sched, 7)
      const scheduling = suggestions.find((s) => s.title.startsWith('Schedule heavy tasks for'))
      expect(scheduling).toBeDefined()
      expect(scheduling!.actionable).toBe(false)
    })

    it('marks workflow break-reminder suggestions as actionable=false', () => {
      const sched = makeSchedulePattern({ breakGaps: [15, 20] })
      const suggestions = generator.generateWorkflowSuggestions(sched, 7)
      const breaks = suggestions.find((s) => s.title === 'Configure break reminders')
      expect(breaks).toBeDefined()
      expect(breaks!.actionable).toBe(false)
    })

    it('marks skill suggestions as actionable=true', () => {
      const pattern = makeToolPattern({
        appCounts: new Map([['VSCode', 50]]),
        topApps: ['VSCode'],
        categoryBreakdown: new Map([['coding', 50]]),
      })
      const suggestions = generator.generateSkillSuggestions(pattern, 7)
      expect(suggestions.length).toBeGreaterThan(0)
      for (const s of suggestions) {
        expect(s.actionable).toBe(true)
      }
    })

    it('marks automation suggestions as actionable=true', () => {
      const proj = makeProjectPattern()
      const suggestions = generator.generateAutomationSuggestions(proj, 7)
      expect(suggestions.length).toBeGreaterThan(0)
      for (const s of suggestions) {
        expect(s.actionable).toBe(true)
      }
    })

    it('all generated suggestions include estimatedComplexity', () => {
      const patterns = makeDetectedPatterns()
      const suggestions = generator.generate(patterns)
      for (const s of suggestions) {
        expect(['solo', 'team', 'complex']).toContain(s.estimatedComplexity)
      }
    })
  })

  // ── Filtering ────────────────────────────────────────────────────

  describe('filtering', () => {
    it('skips suggestions below minimum confidence', () => {
      const gen = createSuggestionGenerator(
        {
          scorer: createConfidenceScorer(),
          evidenceGatherer: createEvidenceGatherer(),
          store: createMockStore(),
        },
        { minimumConfidence: 0.99 },
      )
      const pattern = makeToolPattern({
        appCounts: new Map([['VSCode', 21]]),
        topApps: ['VSCode'],
        categoryBreakdown: new Map([['coding', 21]]),
      })
      const suggestions = gen.generateSkillSuggestions(pattern, 7)
      expect(suggestions).toHaveLength(0)
    })

    it('respects maxSuggestionsPerCycle cap', () => {
      const gen = createSuggestionGenerator(
        {
          scorer: createConfidenceScorer(),
          evidenceGatherer: createEvidenceGatherer(),
          store: createMockStore(),
        },
        { minimumConfidence: 0.1, maxSuggestionsPerCycle: 2 },
      )
      const patterns = makeDetectedPatterns()
      const suggestions = gen.generate(patterns)
      expect(suggestions.length).toBeLessThanOrEqual(2)
    })

    it('all generated suggestions are saved to store', () => {
      const localStore = createMockStore()
      const gen = createSuggestionGenerator(
        {
          scorer: createConfidenceScorer(),
          evidenceGatherer: createEvidenceGatherer(),
          store: localStore,
        },
        { minimumConfidence: 0.1 },
      )
      const pattern = makeToolPattern({
        appCounts: new Map([['VSCode', 50]]),
        topApps: ['VSCode'],
        categoryBreakdown: new Map([['coding', 50]]),
      })
      const suggestions = gen.generateSkillSuggestions(pattern, 7)
      expect(suggestions.length).toBeGreaterThan(0)
      for (const s of suggestions) {
        expect(localStore.get(s.id)).not.toBeNull()
      }
    })
  })

  // ── Full Pipeline (generate) ─────────────────────────────────────

  describe('generate (full pipeline)', () => {
    it('returns mix of suggestion types from all patterns', () => {
      const patterns = makeDetectedPatterns()
      const suggestions = generator.generate(patterns)
      expect(suggestions.length).toBeGreaterThan(0)
      const types = new Set(suggestions.map((s) => s.type))
      expect(types.size).toBeGreaterThanOrEqual(2)
    })

    it('returns empty array when all patterns are null', () => {
      const patterns = makeDetectedPatterns({
        workSchedule: null,
        toolFrequency: null,
        projectFocus: null,
      })
      const suggestions = generator.generate(patterns)
      expect(suggestions).toHaveLength(0)
    })

    it('generates only relevant suggestions for partial patterns', () => {
      const patterns = makeDetectedPatterns({
        workSchedule: null,
        projectFocus: null,
      })
      const suggestions = generator.generate(patterns)
      // Only tool-based suggestions (skill, mcp) should appear
      for (const s of suggestions) {
        expect(['skill', 'mcp']).toContain(s.type)
      }
    })

    it('every suggestion has a valid uuid id', () => {
      const patterns = makeDetectedPatterns()
      const suggestions = generator.generate(patterns)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      for (const s of suggestions) {
        expect(s.id).toMatch(uuidRegex)
      }
    })

    it('every suggestion has pending status', () => {
      const patterns = makeDetectedPatterns()
      const suggestions = generator.generate(patterns)
      for (const s of suggestions) {
        expect(s.status).toBe('pending')
      }
    })

    it('every suggestion has confidence between 0 and 1', () => {
      const patterns = makeDetectedPatterns()
      const suggestions = generator.generate(patterns)
      for (const s of suggestions) {
        expect(s.confidence).toBeGreaterThanOrEqual(0)
        expect(s.confidence).toBeLessThanOrEqual(1)
      }
    })
  })

  // ── generateFromAllSources ───────────────────────────────────────

  describe('generateFromAllSources', () => {
    it('with observation patterns only produces observation-based suggestions', () => {
      const patterns = makeDetectedPatterns()
      const suggestions = generator.generateFromAllSources(patterns)
      expect(suggestions.length).toBeGreaterThan(0)
      // Should produce the same types as the existing generate()
      const types = new Set(suggestions.map((s) => s.type))
      expect(types.size).toBeGreaterThanOrEqual(2)
    })

    it('with both patterns produces suggestions from both sources', () => {
      const patterns = makeDetectedPatterns()
      const otelPatterns: ExtractedPatterns = {
        schedule: {
          activeHours: [{ hour: 10, sessionCount: 5 }],
          activeDays: [{ day: 'Monday', sessionCount: 5 }],
          avgSessionDuration: 3600000,
          avgTokensPerSession: { input: 1000, output: 2000 },
        },
        tools: {
          topTools: [
            { tool: 'bash', totalUses: 50, avgDurationMs: 100 },
            { tool: 'edit', totalUses: 40, avgDurationMs: 50 },
            { tool: 'view', totalUses: 35, avgDurationMs: 30 },
          ],
          mcpServers: [{ server: 'github-mcp', sessionCount: 4 }],
          skills: [{ skill: 'code-review', sessionCount: 4 }],
        },
        models: {
          models: [{ model: 'claude-sonnet-4', totalCalls: 30, sessionCount: 4 }],
          primaryModel: 'claude-sonnet-4',
        },
        totalSessions: 5,
        analyzedFrom: '2025-01-01T00:00:00.000Z',
        analyzedTo: '2025-01-08T00:00:00.000Z',
        extractedAt: '2025-01-08T00:00:00.000Z',
      }
      const suggestions = generator.generateFromAllSources(patterns, otelPatterns)
      expect(suggestions.length).toBeGreaterThan(0)
      // Should include observation-based types plus potentially extractor types
      const types = new Set(suggestions.map((s) => s.type))
      expect(types.size).toBeGreaterThanOrEqual(2)
    })

    it('respects maxPerCycle across all sources', () => {
      const localStore = createMockStore()
      const gen = createSuggestionGenerator(
        {
          scorer: createConfidenceScorer(),
          evidenceGatherer: createEvidenceGatherer(),
          store: localStore,
        },
        { minimumConfidence: 0.1, maxSuggestionsPerCycle: 2 },
      )
      const patterns = makeDetectedPatterns()
      const otelPatterns: ExtractedPatterns = {
        schedule: {
          activeHours: [{ hour: 10, sessionCount: 5 }],
          activeDays: [{ day: 'Monday', sessionCount: 5 }],
          avgSessionDuration: 3600000,
          avgTokensPerSession: { input: 1000, output: 2000 },
        },
        tools: {
          topTools: [
            { tool: 'bash', totalUses: 50, avgDurationMs: 100 },
            { tool: 'edit', totalUses: 40, avgDurationMs: 50 },
          ],
          mcpServers: [],
          skills: [],
        },
        models: {
          models: [{ model: 'claude-sonnet-4', totalCalls: 30, sessionCount: 4 }],
          primaryModel: 'claude-sonnet-4',
        },
        totalSessions: 5,
        analyzedFrom: '2025-01-01T00:00:00.000Z',
        analyzedTo: '2025-01-08T00:00:00.000Z',
        extractedAt: '2025-01-08T00:00:00.000Z',
      }
      const suggestions = gen.generateFromAllSources(patterns, otelPatterns)
      expect(suggestions.length).toBeLessThanOrEqual(2)
    })

    it('deduplicates across sources', () => {
      const patterns = makeDetectedPatterns()
      // First call generates observation-based suggestions
      const first = generator.generateFromAllSources(patterns)
      expect(first.length).toBeGreaterThan(0)
      // Second call with same patterns should produce 0 new (all deduped)
      const second = generator.generateFromAllSources(patterns)
      expect(second).toHaveLength(0)
    })

    it('generate still works for backward compatibility', () => {
      const patterns = makeDetectedPatterns()
      const fromGenerate = generator.generate(patterns)
      expect(fromGenerate.length).toBeGreaterThan(0)
      const types = new Set(fromGenerate.map((s) => s.type))
      expect(types.size).toBeGreaterThanOrEqual(2)
    })
  })
})

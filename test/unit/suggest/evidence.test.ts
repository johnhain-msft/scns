import { describe, it, expect } from 'vitest'
import { createEvidenceGatherer } from '../../../src/suggest/evidence.js'
import type { OtelPatterns } from '../../../src/suggest/evidence.js'
import type { Evidence } from '../../../src/suggest/types.js'
import type {
  ToolFrequencyPattern,
  WorkSchedulePattern,
  ProjectFocusPattern,
  DetectedPatterns,
} from '../../../src/observe/pattern-detector.js'

// ── Helpers ────────────────────────────────────────────────────────

function makeToolPattern(overrides?: Partial<ToolFrequencyPattern>): ToolFrequencyPattern {
  return {
    appCounts: new Map([
      ['VSCode', 40],
      ['Chrome', 20],
      ['Terminal', 10],
    ]),
    topApps: ['VSCode', 'Chrome', 'Terminal'],
    categoryBreakdown: new Map([
      ['coding', 40],
      ['browsing', 20],
      ['terminal', 10],
    ]),
    ...overrides,
  }
}

function makeSchedulePattern(overrides?: Partial<WorkSchedulePattern>): WorkSchedulePattern {
  return {
    activeHours: [9, 10, 11, 14, 15, 16],
    peakHour: 10,
    averageSessionMinutes: 45,
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
    observationCount: 100,
    windowStart: '2025-01-01T00:00:00.000Z',
    windowEnd: '2025-01-07T23:59:59.000Z',
    ...overrides,
  }
}

describe('createEvidenceGatherer', () => {
  const gatherer = createEvidenceGatherer()

  // ── Tool Evidence ──────────────────────────────────────────────

  describe('gatherToolEvidence', () => {
    it('extracts evidence from top apps', () => {
      const evidence = gatherer.gatherToolEvidence(makeToolPattern())
      expect(evidence.length).toBeGreaterThan(0)
      expect(evidence.some((e) => e.detail.includes('VSCode'))).toBe(true)
    })

    it('has weight proportional to usage count', () => {
      const evidence = gatherer.gatherToolEvidence(makeToolPattern())
      const vscode = evidence.find((e) => e.detail.includes('VSCode'))!
      const terminal = evidence.find((e) => e.detail.includes('Terminal'))!
      expect(vscode.weight).toBeGreaterThan(terminal.weight)
    })

    it('sets source to tool-frequency', () => {
      const evidence = gatherer.gatherToolEvidence(makeToolPattern())
      for (const e of evidence) {
        expect(e.source).toBe('tool-frequency')
      }
    })

    it('respects maxEvidencePerSuggestion limit', () => {
      const limited = createEvidenceGatherer({ maxEvidencePerSuggestion: 2 })
      const evidence = limited.gatherToolEvidence(makeToolPattern())
      expect(evidence.length).toBeLessThanOrEqual(2)
    })
  })

  // ── Schedule Evidence ──────────────────────────────────────────

  describe('gatherScheduleEvidence', () => {
    it('extracts peak hour evidence', () => {
      const evidence = gatherer.gatherScheduleEvidence(makeSchedulePattern())
      expect(evidence.some((e) => e.detail.includes('10:00'))).toBe(true)
    })

    it('extracts session length evidence', () => {
      const evidence = gatherer.gatherScheduleEvidence(makeSchedulePattern())
      expect(evidence.some((e) => e.detail.includes('45'))).toBe(true)
    })

    it('extracts break pattern evidence', () => {
      const schedule = makeSchedulePattern({ breakGaps: [15, 30, 60] })
      const evidence = gatherer.gatherScheduleEvidence(schedule)
      expect(evidence.some((e) => e.detail.toLowerCase().includes('break'))).toBe(true)
    })

    it('sets source to work-schedule', () => {
      const evidence = gatherer.gatherScheduleEvidence(makeSchedulePattern())
      for (const e of evidence) {
        expect(e.source).toBe('work-schedule')
      }
    })
  })

  // ── Project Evidence ───────────────────────────────────────────

  describe('gatherProjectEvidence', () => {
    it('extracts top repo evidence', () => {
      const evidence = gatherer.gatherProjectEvidence(makeProjectPattern())
      expect(evidence.some((e) => e.detail.includes('scns'))).toBe(true)
    })

    it('extracts recent focus evidence', () => {
      const evidence = gatherer.gatherProjectEvidence(makeProjectPattern())
      expect(evidence.some((e) => e.detail.toLowerCase().includes('focused'))).toBe(true)
    })

    it('extracts file type evidence', () => {
      const evidence = gatherer.gatherProjectEvidence(makeProjectPattern())
      expect(evidence.some((e) => e.detail.includes('ts'))).toBe(true)
    })

    it('sets source to project-focus', () => {
      const evidence = gatherer.gatherProjectEvidence(makeProjectPattern())
      for (const e of evidence) {
        expect(e.source).toBe('project-focus')
      }
    })
  })

  // ── Pattern Integration ────────────────────────────────────────

  describe('gatherFromPatterns', () => {
    it('routes skill → tool evidence', () => {
      const evidence = gatherer.gatherFromPatterns(makeDetectedPatterns(), 'skill')
      expect(evidence.some((e) => e.source === 'tool-frequency')).toBe(true)
    })

    it('routes automation → project + schedule evidence', () => {
      const evidence = gatherer.gatherFromPatterns(makeDetectedPatterns(), 'automation')
      const sources = new Set(evidence.map((e) => e.source))
      expect(sources.has('project-focus')).toBe(true)
      expect(sources.has('work-schedule')).toBe(true)
    })

    it('handles null patterns gracefully', () => {
      const patterns = makeDetectedPatterns({
        toolFrequency: null,
        workSchedule: null,
        projectFocus: null,
      })
      const evidence = gatherer.gatherFromPatterns(patterns, 'skill')
      expect(evidence).toEqual([])
    })

    it('returns empty evidence for empty patterns', () => {
      const patterns = makeDetectedPatterns({
        toolFrequency: null,
        workSchedule: null,
        projectFocus: null,
      })
      const evidence = gatherer.gatherFromPatterns(patterns, 'workflow')
      expect(evidence).toEqual([])
    })
  })

  // ── Format Evidence ────────────────────────────────────────────

  // ── OTel Evidence ──────────────────────────────────────────────

  describe('gatherOtelEvidence', () => {
    it('extracts evidence from topTools', () => {
      const otel: OtelPatterns = {
        topTools: [
          { tool: 'bash', totalUses: 100 },
          { tool: 'view', totalUses: 50 },
        ],
      }
      const evidence = gatherer.gatherOtelEvidence(otel)
      expect(evidence.length).toBeGreaterThan(0)
      expect(evidence.some((e) => e.detail.includes('bash'))).toBe(true)
      expect(evidence.every((e) => e.source === 'otel-patterns')).toBe(true)
    })

    it('extracts evidence from mcpServers', () => {
      const otel: OtelPatterns = {
        mcpServers: [{ server: 'github', sessionCount: 10 }],
      }
      const evidence = gatherer.gatherOtelEvidence(otel)
      expect(evidence.some((e) => e.detail.includes('github'))).toBe(true)
    })

    it('extracts evidence from skills', () => {
      const otel: OtelPatterns = {
        skills: [{ skill: 'deploy-azure', sessionCount: 5 }],
      }
      const evidence = gatherer.gatherOtelEvidence(otel)
      expect(evidence.some((e) => e.detail.includes('deploy-azure'))).toBe(true)
    })

    it('extracts evidence from models', () => {
      const otel: OtelPatterns = {
        models: [{ model: 'claude-sonnet-4', totalCalls: 200 }],
      }
      const evidence = gatherer.gatherOtelEvidence(otel)
      expect(evidence.some((e) => e.detail.includes('claude-sonnet-4'))).toBe(true)
    })

    it('returns empty evidence when no data provided', () => {
      const evidence = gatherer.gatherOtelEvidence({})
      expect(evidence).toEqual([])
    })

    it('respects maxEvidencePerSuggestion limit', () => {
      const limited = createEvidenceGatherer({ maxEvidencePerSuggestion: 2 })
      const otel: OtelPatterns = {
        topTools: [
          { tool: 'bash', totalUses: 100 },
          { tool: 'view', totalUses: 50 },
          { tool: 'grep', totalUses: 30 },
        ],
        mcpServers: [{ server: 'github', sessionCount: 10 }],
      }
      const evidence = limited.gatherOtelEvidence(otel)
      expect(evidence.length).toBeLessThanOrEqual(2)
    })
  })

  // ── gatherFromPatterns with new types ──────────────────────────

  describe('gatherFromPatterns with new types', () => {
    it('routes prompt → otelPatterns source', () => {
      const otel: OtelPatterns = {
        topTools: [{ tool: 'bash', totalUses: 50 }],
      }
      const evidence = gatherer.gatherFromPatterns(makeDetectedPatterns(), 'prompt', otel)
      expect(evidence.some((e) => e.source === 'otel-patterns')).toBe(true)
    })

    it('routes extension → toolFrequency + otelPatterns', () => {
      const otel: OtelPatterns = {
        topTools: [{ tool: 'bash', totalUses: 50 }],
      }
      const evidence = gatherer.gatherFromPatterns(makeDetectedPatterns(), 'extension', otel)
      const sources = new Set(evidence.map((e) => e.source))
      expect(sources.has('tool-frequency')).toBe(true)
      expect(sources.has('otel-patterns')).toBe(true)
    })

    it('routes lsp → projectFocus', () => {
      const evidence = gatherer.gatherFromPatterns(makeDetectedPatterns(), 'lsp')
      expect(evidence.some((e) => e.source === 'project-focus')).toBe(true)
    })

    it('routes github-action → projectFocus + workSchedule', () => {
      const evidence = gatherer.gatherFromPatterns(makeDetectedPatterns(), 'github-action')
      const sources = new Set(evidence.map((e) => e.source))
      expect(sources.has('project-focus')).toBe(true)
      expect(sources.has('work-schedule')).toBe(true)
    })

    it('routes agentic-workflow → toolFrequency + otelPatterns', () => {
      const otel: OtelPatterns = {
        topTools: [{ tool: 'bash', totalUses: 50 }],
      }
      const evidence = gatherer.gatherFromPatterns(makeDetectedPatterns(), 'agentic-workflow', otel)
      const sources = new Set(evidence.map((e) => e.source))
      expect(sources.has('tool-frequency')).toBe(true)
      expect(sources.has('otel-patterns')).toBe(true)
    })

    it('routes instruction → otelPatterns source', () => {
      const otel: OtelPatterns = {
        topTools: [{ tool: 'bash', totalUses: 50 }],
      }
      const evidence = gatherer.gatherFromPatterns(makeDetectedPatterns(), 'instruction', otel)
      expect(evidence.some((e) => e.source === 'otel-patterns')).toBe(true)
    })

    it('returns empty for new type when otelPatterns not provided', () => {
      const evidence = gatherer.gatherFromPatterns(
        makeDetectedPatterns({ toolFrequency: null, projectFocus: null, workSchedule: null }),
        'prompt',
      )
      expect(evidence).toEqual([])
    })
  })

  describe('formatEvidence', () => {
    it('produces bullet list', () => {
      const evidence: readonly Evidence[] = [
        {
          source: 'tool-frequency',
          detail: "Tool 'VSCode' used 40 times",
          observedAt: '2025-01-07T00:00:00.000Z',
          weight: 1.0,
        },
        {
          source: 'work-schedule',
          detail: 'Most active at 10:00',
          observedAt: '2025-01-07T00:00:00.000Z',
          weight: 0.6,
        },
      ]
      const result = gatherer.formatEvidence(evidence)
      expect(result).toContain('- **tool-frequency**')
      expect(result).toContain('- **work-schedule**')
      expect(result).toContain('VSCode')
      expect(result).toContain('10:00')
    })

    it('returns empty string for empty array', () => {
      expect(gatherer.formatEvidence([])).toBe('')
    })
  })
})

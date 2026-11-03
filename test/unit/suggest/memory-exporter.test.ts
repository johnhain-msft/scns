import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMemoryExporter } from '../../../src/suggest/memory-exporter.js'
import type { Suggestion } from '../../../src/suggest/types.js'
import type { ExtractedPatterns } from '../../../src/otel/pattern-extractor.js'

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'skill',
    title: 'Git Commit Helper',
    description: 'Automate git commit patterns.',
    status: 'approved',
    confidence: 0.85,
    evidence: [
      {
        source: 'tool-frequency',
        detail: 'Git used 45 times',
        observedAt: '2025-01-15T10:00:00Z',
        weight: 0.8,
      },
    ],
    tags: ['git', 'automation'],
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:00:00Z',
    ...overrides,
  }
}

function makePatterns(): ExtractedPatterns {
  return {
    schedule: {
      activeHours: [
        { hour: 9, sessionCount: 8 },
        { hour: 10, sessionCount: 12 },
        { hour: 14, sessionCount: 10 },
        { hour: 15, sessionCount: 7 },
      ],
      activeDays: [
        { day: 'Monday', sessionCount: 10 },
        { day: 'Tuesday', sessionCount: 9 },
        { day: 'Wednesday', sessionCount: 11 },
        { day: 'Thursday', sessionCount: 8 },
        { day: 'Friday', sessionCount: 7 },
      ],
      avgSessionDuration: 1500000,
      avgTokensPerSession: { input: 5000, output: 3000 },
    },
    tools: {
      topTools: [
        { tool: 'Read', totalUses: 150, avgDurationMs: 50 },
        { tool: 'Edit', totalUses: 120, avgDurationMs: 80 },
      ],
      mcpServers: [{ server: 'filesystem', sessionCount: 20 }],
      skills: [],
    },
    models: {
      models: [{ model: 'claude-sonnet', totalCalls: 200, sessionCount: 40 }],
      primaryModel: 'claude-sonnet',
    },
    totalSessions: 50,
    analyzedFrom: '2025-01-01T00:00:00Z',
    analyzedTo: '2025-01-15T00:00:00Z',
    extractedAt: '2025-01-15T10:00:00Z',
  }
}

describe('Memory Exporter', () => {
  let outputDir: string

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'scns-export-'))
  })

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true })
  })

  describe('exportSuggestions — JSON format', () => {
    it('exports suggestions as valid JSON', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'json' })
      const suggestions = [
        makeSuggestion(),
        makeSuggestion({ id: '660e8400-e29b-41d4-a716-446655440001', title: 'Other skill' }),
      ]
      const result = exporter.exportSuggestions(suggestions)

      expect(result.entriesExported).toBe(2)
      expect(result.path).toContain(outputDir)
      expect(result.exportedAt).toBeTruthy()

      const content = readFileSync(result.path, 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed).toHaveLength(2)
      expect(parsed[0].title).toBe('Git Commit Helper')
    })

    it('includes exportedAt as ISO datetime', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'json' })
      const result = exporter.exportSuggestions([makeSuggestion()])

      expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('exportSuggestions — Markdown format', () => {
    it('exports suggestions as markdown', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'markdown' })
      const suggestions = [makeSuggestion()]
      const result = exporter.exportSuggestions(suggestions)

      expect(result.entriesExported).toBe(1)
      const content = readFileSync(result.path, 'utf-8')
      expect(content).toContain('# Suggestions Export')
      expect(content).toContain('Git Commit Helper')
    })

    it('includes evidence in markdown export', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'markdown' })
      const suggestions = [makeSuggestion()]
      const result = exporter.exportSuggestions(suggestions)

      const content = readFileSync(result.path, 'utf-8')
      expect(content).toContain('Git used 45 times')
    })
  })

  describe('exportSuggestions — filtering', () => {
    it('filters by status', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'json' })
      const suggestions = [
        makeSuggestion({ status: 'approved' }),
        makeSuggestion({ id: '660e8400-e29b-41d4-a716-446655440001', status: 'rejected' }),
      ]
      const result = exporter.exportSuggestions(suggestions, { status: 'approved' })

      expect(result.entriesExported).toBe(1)
      const content = readFileSync(result.path, 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed).toHaveLength(1)
      expect(parsed[0].status).toBe('approved')
    })

    it('filters by type', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'json' })
      const suggestions = [
        makeSuggestion({ type: 'skill' }),
        makeSuggestion({ id: '660e8400-e29b-41d4-a716-446655440001', type: 'prompt' }),
      ]
      const result = exporter.exportSuggestions(suggestions, { type: 'skill' })

      expect(result.entriesExported).toBe(1)
    })

    it('filters by tags', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'json' })
      const suggestions = [
        makeSuggestion({ tags: ['git', 'automation'] }),
        makeSuggestion({ id: '660e8400-e29b-41d4-a716-446655440001', tags: ['docker'] }),
      ]
      const result = exporter.exportSuggestions(suggestions, { tags: ['git'] })

      expect(result.entriesExported).toBe(1)
    })
  })

  describe('exportSuggestions — empty results', () => {
    it('handles empty suggestion list', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'json' })
      const result = exporter.exportSuggestions([])

      expect(result.entriesExported).toBe(0)
      expect(result.path).toContain(outputDir)
      const content = readFileSync(result.path, 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed).toHaveLength(0)
    })

    it('handles filter that matches nothing', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'json' })
      const result = exporter.exportSuggestions([makeSuggestion()], { type: 'extension' })

      expect(result.entriesExported).toBe(0)
    })
  })

  describe('exportSuggestions — maxEntries', () => {
    it('respects maxEntries limit', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'json', maxEntries: 1 })
      const suggestions = [
        makeSuggestion(),
        makeSuggestion({ id: '660e8400-e29b-41d4-a716-446655440001', title: 'Other' }),
      ]
      const result = exporter.exportSuggestions(suggestions)

      expect(result.entriesExported).toBe(1)
    })
  })

  describe('exportPatterns', () => {
    it('exports patterns as JSON', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'json' })
      const patterns = makePatterns()
      const result = exporter.exportPatterns(patterns)

      expect(result.entriesExported).toBe(1)
      expect(result.path).toContain(outputDir)
      const content = readFileSync(result.path, 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed.totalSessions).toBe(50)
    })

    it('exports patterns as markdown', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'markdown' })
      const patterns = makePatterns()
      const result = exporter.exportPatterns(patterns)

      const content = readFileSync(result.path, 'utf-8')
      expect(content).toContain('# Patterns Export')
      expect(content).toContain('50')
    })
  })

  describe('ExportResult metadata', () => {
    it('contains valid path', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'json' })
      const result = exporter.exportSuggestions([makeSuggestion()])

      expect(existsSync(result.path)).toBe(true)
    })

    it('contains correct entriesExported count', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'json' })
      const suggestions = [
        makeSuggestion(),
        makeSuggestion({ id: '660e8400-e29b-41d4-a716-446655440001' }),
        makeSuggestion({ id: '770e8400-e29b-41d4-a716-446655440002' }),
      ]
      const result = exporter.exportSuggestions(suggestions)

      expect(result.entriesExported).toBe(3)
    })

    it('contains exportedAt as ISO datetime string', () => {
      const exporter = createMemoryExporter({ outputDir, format: 'json' })
      const result = exporter.exportSuggestions([])

      expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  })
})

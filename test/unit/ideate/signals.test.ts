/**
 * D1 — gatherIdeationSignals assembles the real-world inputs to ideation from
 * INJECTED sources (so this suite needs no DB / telemetry / repo). Also covers
 * the pure adapters that turn live data (otel ExtractedPatterns, suggestion
 * store, src/ dir) into prompt-friendly signal shapes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  gatherIdeationSignals,
  telemetrySignalFromPatterns,
  summarizeRecentOutcomes,
  readCodebaseSignal,
} from '../../../src/ideate/signals.js'
import type { ExtractedPatterns } from '../../../src/otel/pattern-extractor.js'

describe('gatherIdeationSignals', () => {
  const base = {
    telemetry: () => null,
    codebase: () => ({ modules: ['brain'], description: 'SCNS' }),
    recentOutcomes: () => ({ implemented: [], rejected: [], failed: [], pendingCount: 0 }),
    openGaps: () => [{ source: 'issue-5', detail: 'x' }],
  }

  it('assembles all sources with a generatedAt timestamp', () => {
    const s = gatherIdeationSignals({ ...base, now: () => new Date('2026-06-23T00:00:00.000Z') })
    expect(s.generatedAt).toBe('2026-06-23T00:00:00.000Z')
    expect(s.codebase.modules).toEqual(['brain'])
    expect(s.openGaps).toHaveLength(1)
  })

  it('defaults priorProposalOutcomes to [] when no source is given (D1)', () => {
    const s = gatherIdeationSignals(base)
    expect(s.priorProposalOutcomes).toEqual([])
  })

  it('passes through priorProposalOutcomes when a source is given (D2 readiness)', () => {
    const s = gatherIdeationSignals({
      ...base,
      priorProposalOutcomes: () => [{ title: 't', outcome: 'merged' }],
    })
    expect(s.priorProposalOutcomes).toEqual([{ title: 't', outcome: 'merged' }])
  })

  it('isolates a throwing source so one failure cannot abort ideation', () => {
    const s = gatherIdeationSignals({
      ...base,
      telemetry: () => {
        throw new Error('telemetry read failed')
      },
      openGaps: () => {
        throw new Error('gh failed')
      },
    })
    expect(s.telemetry).toBeNull()
    expect(s.openGaps).toEqual([])
    expect(s.codebase.modules).toEqual(['brain'])
  })
})

describe('telemetrySignalFromPatterns', () => {
  it('returns null for null input', () => {
    expect(telemetrySignalFromPatterns(null)).toBeNull()
  })

  it('maps ExtractedPatterns into a compact signal', () => {
    const patterns: ExtractedPatterns = {
      schedule: {
        activeHours: [
          { hour: 9, sessionCount: 2 },
          { hour: 21, sessionCount: 8 },
        ],
        activeDays: [],
        avgSessionDuration: null,
        avgTokensPerSession: { input: 0, output: 0 },
      },
      tools: {
        topTools: [{ tool: 'bash', totalUses: 100, avgDurationMs: null }],
        mcpServers: [],
        skills: [],
      },
      models: {
        models: [{ model: 'claude-opus-4.8', totalCalls: 300, sessionCount: 40 }],
        primaryModel: 'claude-opus-4.8',
      },
      totalSessions: 40,
      analyzedFrom: '2026-06-16T00:00:00.000Z',
      analyzedTo: '2026-06-23T00:00:00.000Z',
      extractedAt: '2026-06-23T00:00:00.000Z',
    }
    const sig = telemetrySignalFromPatterns(patterns)
    expect(sig).not.toBeNull()
    expect(sig!.totalSessions).toBe(40)
    expect(sig!.windowDays).toBe(7)
    expect(sig!.primaryModel).toBe('claude-opus-4.8')
    expect(sig!.topTools[0]).toEqual({ tool: 'bash', uses: 100 })
    expect(sig!.topModels[0]).toEqual({ model: 'claude-opus-4.8', calls: 300 })
    // busiest hour first
    expect(sig!.busiestHours[0]).toEqual({ hour: 21, sessions: 8 })
  })

  it('defaults windowDays to >=1 when timestamps are missing', () => {
    const empty: ExtractedPatterns = {
      schedule: { activeHours: [], activeDays: [], avgSessionDuration: null, avgTokensPerSession: { input: 0, output: 0 } },
      tools: { topTools: [], mcpServers: [], skills: [] },
      models: { models: [], primaryModel: null },
      totalSessions: 0,
      analyzedFrom: '',
      analyzedTo: '',
      extractedAt: '2026-06-23T00:00:00.000Z',
    }
    expect(telemetrySignalFromPatterns(empty)!.windowDays).toBeGreaterThanOrEqual(1)
  })
})

describe('summarizeRecentOutcomes', () => {
  it('buckets suggestions by status and caps each bucket', () => {
    const suggestions = [
      { title: 'A', status: 'implemented' },
      { title: 'B', status: 'rejected' },
      { title: 'C', status: 'failed' },
      { title: 'D', status: 'pending' },
      { title: 'E', status: 'pending' },
      { title: 'F', status: 'implemented' },
    ]
    const r = summarizeRecentOutcomes(suggestions, { max: 1 })
    expect(r.implemented).toHaveLength(1)
    expect(r.rejected).toEqual(['B'])
    expect(r.failed).toEqual(['C'])
    expect(r.pendingCount).toBe(2)
  })

  it('tolerates an empty list', () => {
    const r = summarizeRecentOutcomes([])
    expect(r).toEqual({ implemented: [], rejected: [], failed: [], pendingCount: 0 })
  })
})

describe('readCodebaseSignal', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scns-ideate-src-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('lists immediate subdirectories as modules', () => {
    mkdirSync(join(root, 'brain'))
    mkdirSync(join(root, 'broker'))
    writeFileSync(join(root, 'cli.ts'), '// not a dir', 'utf-8')
    const sig = readCodebaseSignal(root, 'desc')
    expect([...sig.modules].sort()).toEqual(['brain', 'broker'])
    expect(sig.description).toBe('desc')
  })

  it('returns empty modules when the dir is missing', () => {
    const sig = readCodebaseSignal(join(root, 'nope'), 'desc')
    expect(sig.modules).toEqual([])
  })
})

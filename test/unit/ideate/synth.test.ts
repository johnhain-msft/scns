/**
 * D1b — deterministic, evidence-first ideation synthesizer. Proves it INVENTS
 * proposals from live signal VALUES (not a fixed menu), grounds each in cited
 * evidence, drops anything already in recent/prior outcomes (novelty), caps at K,
 * is honest when signals are thin, and the backend adapter emits parseable JSON.
 */
import { describe, it, expect } from 'vitest'
import { synthesizeProposals, createSynthIdeationBackend } from '../../../src/ideate/synth.js'
import { parseIdeationResponse } from '../../../src/ideate/parse.js'
import type { IdeationSignals } from '../../../src/ideate/types.js'

function signals(over: Partial<IdeationSignals> = {}): IdeationSignals {
  return {
    generatedAt: '2026-06-28T00:00:00.000Z',
    telemetry: {
      totalSessions: 100,
      windowDays: 7,
      primaryModel: 'claude-opus-4.8',
      topTools: [{ tool: 'edit', uses: 42 }],
      topModels: [],
      busiestHours: [],
    },
    codebase: { modules: ['broker', 'memory'], description: 'SCNS' },
    recentOutcomes: { implemented: [], rejected: [], failed: [], pendingCount: 0 },
    openGaps: [{ source: 'github-issue-5', detail: 'auto-merger refuses dirty tree' }],
    priorProposalOutcomes: [],
    ...over,
  }
}

describe('synthesizeProposals', () => {
  it('composes proposals from live signal values (not a fixed catalog)', () => {
    const out = synthesizeProposals(signals(), { k: 5 })
    expect(out.length).toBeGreaterThan(0)
    const titles = out.map((p) => p.title).join(' | ')
    expect(titles).toContain('auto-merger refuses dirty tree') // gap detail flowed in
    expect(titles).toContain('edit') // hottest tool name flowed in
    expect(titles).toContain('broker') // codebase module flowed in
  })

  it('every proposal is fully populated and evidence-grounded', () => {
    const out = synthesizeProposals(signals(), { k: 5 })
    for (const p of out) {
      expect(p.title).not.toBe('')
      expect(p.rationale).not.toBe('')
      expect(p.expectedValue).not.toBe('')
      expect(p.implementationSketch).not.toBe('')
      expect(p.testableSuccessCriterion).not.toBe('')
    }
    const gap = out.find((p) => p.title.startsWith('Close gap'))
    expect(gap?.rationale).toContain('github-issue-5') // cites the exact source
  })

  it('output tracks the corpus — different gaps yield different titles', () => {
    const a = synthesizeProposals(signals({ openGaps: [{ source: 'x', detail: 'alpha limitation' }] }), { k: 3 })
    const b = synthesizeProposals(signals({ openGaps: [{ source: 'y', detail: 'beta limitation' }] }), { k: 3 })
    expect(a[0].title).toContain('alpha limitation')
    expect(b[0].title).toContain('beta limitation')
    expect(a[0].title).not.toBe(b[0].title)
  })

  it('drops candidates already present in recent/prior outcomes (novelty)', () => {
    const tool = synthesizeProposals(signals(), { k: 9 }).find((p) => p.title.includes('edit'))!
    const out = synthesizeProposals(
      signals({ recentOutcomes: { implemented: [tool.title], rejected: [], failed: [], pendingCount: 0 } }),
      { k: 9 },
    )
    expect(out.some((p) => p.title === tool.title)).toBe(false)
  })

  it('caps at K and is honest (fewer than K) when signals are thin', () => {
    expect(synthesizeProposals(signals(), { k: 2 })).toHaveLength(2)
    const thin = synthesizeProposals(
      { ...signals({ telemetry: null, openGaps: [], codebase: { modules: [], description: '' } }), recentOutcomes: { implemented: [], rejected: [], failed: [], pendingCount: 0 } },
      { k: 5 },
    )
    expect(thin.length).toBeLessThan(5)
  })

  it('returns [] for non-positive k', () => {
    expect(synthesizeProposals(signals(), { k: 0 })).toEqual([])
  })
})

describe('createSynthIdeationBackend', () => {
  it('emits JSON the real parser accepts', async () => {
    const backend = createSynthIdeationBackend(signals(), { k: 4 })
    const raw = await backend.ideate('ignored prompt')
    const parsed = parseIdeationResponse(raw, { max: 4 })
    expect(parsed.proposals.length).toBeGreaterThan(0)
    expect(parsed.dropped).toBe(0)
  })
})

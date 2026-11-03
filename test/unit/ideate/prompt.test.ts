/**
 * D1 — buildIdeationPrompt is a PURE function: given assembled signals + K, it
 * produces the structured ideation prompt. No spawn, no IO. These tests pin the
 * contract the real ACP agent will receive.
 */
import { describe, it, expect } from 'vitest'
import { buildIdeationPrompt } from '../../../src/ideate/prompt.js'
import { IDEATION_PROPOSAL_FIELDS } from '../../../src/ideate/types.js'
import type { IdeationSignals } from '../../../src/ideate/types.js'

function makeSignals(over: Partial<IdeationSignals> = {}): IdeationSignals {
  return {
    generatedAt: '2026-06-23T20:00:00.000Z',
    telemetry: {
      totalSessions: 42,
      windowDays: 7,
      primaryModel: 'claude-opus-4.8',
      topTools: [{ tool: 'bash', uses: 120 }],
      topModels: [{ model: 'claude-opus-4.8', calls: 300 }],
      busiestHours: [{ hour: 21, sessions: 9 }],
    },
    codebase: {
      modules: ['brain', 'broker', 'suggest', 'ideate', 'selfopt'],
      description: 'SCNS — autonomous self-improving multi-agent system.',
    },
    recentOutcomes: {
      implemented: ['Add session rotation'],
      rejected: ['Create png linting automation'],
      failed: ['Flaky worktree cleanup'],
      pendingCount: 3,
    },
    openGaps: [{ source: 'github-issue-5', detail: 'auto-merger refuses dirty tree' }],
    priorProposalOutcomes: [],
    ...over,
  }
}

describe('buildIdeationPrompt', () => {
  it('requests exactly K proposals', () => {
    const p = buildIdeationPrompt(makeSignals(), { k: 4 })
    expect(p).toContain('4')
    expect(p.toLowerCase()).toMatch(/exactly 4|4 (concrete|novel|proposal)/)
  })

  it('demands novel, non-existing improvements', () => {
    const p = buildIdeationPrompt(makeSignals(), { k: 3 }).toLowerCase()
    expect(p).toContain('novel')
    expect(p).toMatch(/do(es)? not (yet )?exist|don't yet exist|new (agents|features|capabilities)/)
  })

  it('lists all five required proposal fields', () => {
    const p = buildIdeationPrompt(makeSignals(), { k: 3 })
    for (const field of IDEATION_PROPOSAL_FIELDS) {
      expect(p).toContain(field)
    }
  })

  it('demands a strict JSON array and forbids prose/markdown', () => {
    const p = buildIdeationPrompt(makeSignals(), { k: 3 }).toLowerCase()
    expect(p).toContain('json')
    expect(p).toMatch(/json array|array of/)
    expect(p).toMatch(/no prose|only json|nothing but|no markdown|do not wrap/)
  })

  it('tells the agent it has no tool access (it must reason from signals)', () => {
    const p = buildIdeationPrompt(makeSignals(), { k: 3 }).toLowerCase()
    expect(p).toMatch(/no tool access|do not (try|attempt)|denied/)
  })

  it('includes every signal section', () => {
    const p = buildIdeationPrompt(makeSignals(), { k: 3 })
    expect(p).toContain('claude-opus-4.8') // telemetry
    expect(p).toContain('ideate') // codebase module
    expect(p).toContain('Add session rotation') // recent implemented
    expect(p).toContain('Create png linting automation') // recent rejected
    expect(p).toContain('github-issue-5') // open gap
  })

  it('tolerates null telemetry without crashing and notes it is unavailable', () => {
    const p = buildIdeationPrompt(makeSignals({ telemetry: null }), { k: 2 })
    expect(typeof p).toBe('string')
    expect(p.toLowerCase()).toMatch(/telemetry|unavailable|no telemetry/)
  })

  it('surfaces prior proposal outcomes when present (D2 readiness)', () => {
    const p = buildIdeationPrompt(
      makeSignals({
        priorProposalOutcomes: [{ title: 'Add caching layer', outcome: 'implemented' }],
      }),
      { k: 2 },
    )
    expect(p).toContain('Add caching layer')
    expect(p).toContain('implemented')
  })

  it('throws on a non-positive K', () => {
    expect(() => buildIdeationPrompt(makeSignals(), { k: 0 })).toThrow()
    expect(() => buildIdeationPrompt(makeSignals(), { k: -1 })).toThrow()
  })
})

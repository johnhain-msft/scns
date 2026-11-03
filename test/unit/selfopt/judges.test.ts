/**
 * Phase 0 — local judges (no judge API call).
 *
 * Rule judge: all-checks-must-pass (hard) + fraction passed (soft), ported from
 * gbrain-evals' programmatic operators. Recorded judge: surfaces a task's
 * historical quality-gate score as the loss signal.
 */
import { describe, it, expect } from 'vitest'
import { recordedJudge, requiredTools, scoreRuleJudge } from '../../../src/selfopt/judges.js'
import type { RuleJudge } from '../../../src/selfopt/types.js'

describe('scoreRuleJudge', () => {
  it('passes hard=1 only when ALL checks pass; soft = fraction', () => {
    const judge: RuleJudge = {
      kind: 'rule',
      checks: [
        { op: 'contains', arg: 'hello' },
        { op: 'min_chars', arg: 3 },
        { op: 'section_present', arg: 'Summary' },
      ],
    }
    const good = '## Summary\nhello world'
    const r1 = scoreRuleJudge(judge, good)
    expect(r1.hard).toBe(1)
    expect(r1.soft).toBe(1)

    const partial = 'hello world' // missing the Summary section
    const r2 = scoreRuleJudge(judge, partial)
    expect(r2.hard).toBe(0)
    expect(r2.soft).toBeCloseTo(2 / 3, 6)
    expect(r2.rationale).toContain('section_present=Summary')
  })

  it('supports regex / max_chars / contains operators', () => {
    const judge: RuleJudge = {
      kind: 'rule',
      checks: [
        { op: 'regex', arg: '\\bv\\d+\\.\\d+\\b' },
        { op: 'max_chars', arg: 20 },
      ],
    }
    expect(scoreRuleJudge(judge, 'v1.2').hard).toBe(1)
    expect(scoreRuleJudge(judge, 'no version here').hard).toBe(0)
  })

  it('tool_called passes via toolsCalled list or an inline marker', () => {
    const judge: RuleJudge = { kind: 'rule', checks: [{ op: 'tool_called', arg: 'grep' }] }
    expect(scoreRuleJudge(judge, 'I will search', ['grep']).hard).toBe(1)
    expect(scoreRuleJudge(judge, 'TOOL_CALL: grep', []).hard).toBe(1)
    expect(scoreRuleJudge(judge, 'no tools', []).hard).toBe(0)
  })

  it('returns 0 with rationale for an empty/absent judge', () => {
    expect(scoreRuleJudge(null, 'x').hard).toBe(0)
    expect(scoreRuleJudge({ kind: 'rule', checks: [] }, 'x').rationale).toBe('no checks')
  })

  it('unknown ops do not block', () => {
    const judge: RuleJudge = { kind: 'rule', checks: [{ op: 'frobnicate', arg: 'x' }] }
    expect(scoreRuleJudge(judge, 'anything').hard).toBe(1)
  })
})

describe('requiredTools', () => {
  it('extracts tool_called args only', () => {
    const judge: RuleJudge = {
      kind: 'rule',
      checks: [
        { op: 'tool_called', arg: 'grep' },
        { op: 'contains', arg: 'x' },
        { op: 'tool_called', arg: 'view' },
      ],
    }
    expect(requiredTools(judge)).toEqual(['grep', 'view'])
    expect(requiredTools(null)).toEqual([])
  })
})

describe('recordedJudge', () => {
  it('surfaces the recorded score as hard and soft, clamped to [0,1]', () => {
    expect(recordedJudge(1)).toEqual({ hard: 1, soft: 1, rationale: 'recorded score 1' })
    expect(recordedJudge(0)).toEqual({ hard: 0, soft: 0, rationale: 'recorded score 0' })
    expect(recordedJudge(0.45).hard).toBeCloseTo(0.45, 6)
    expect(recordedJudge(1.5).hard).toBe(1)
    expect(recordedJudge(-1).hard).toBe(0)
  })

  it('returns 0 when there is no recorded score', () => {
    expect(recordedJudge(null)).toEqual({ hard: 0, soft: 0, rationale: 'no recorded score' })
    expect(recordedJudge(Number.NaN).hard).toBe(0)
  })
})

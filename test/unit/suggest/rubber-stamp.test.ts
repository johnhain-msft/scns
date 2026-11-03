import { describe, it, expect } from 'vitest'
import {
  assessEngagement,
  MIN_ASSESSABLE_REVIEWS,
  type ReviewRecord,
} from '../../../src/suggest/rubber-stamp.js'

function rec(o: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    verdict: 'approve',
    code: 'unblocks',
    text: 'this genuinely unblocks the scheduler work i have been waiting on',
    at: '2026-07-20T00:00:00.000Z',
    ...o,
  }
}

describe('assessEngagement — insufficient data', () => {
  it('refuses to judge on too few reviews and blocks escalation', () => {
    const a = assessEngagement([rec(), rec()])
    expect(a.sufficientData).toBe(false)
    expect(a.readyToEscalate).toBe(false)
    expect(MIN_ASSESSABLE_REVIEWS).toBeGreaterThan(2)
  })

  it('treats an empty history as not ready (NEGATIVE CONTROL)', () => {
    const a = assessEngagement([])
    expect(a.sufficientData).toBe(false)
    expect(a.readyToEscalate).toBe(false)
    expect(a.rubberStamping).toBe(false)
  })
})

describe('assessEngagement — detects rubber-stamping', () => {
  it('flags uniform approval with a single repeated code', () => {
    const a = assessEngagement(Array.from({ length: 12 }, () => rec()))
    expect(a.approvalRate).toBe(1)
    expect(a.reasonEntropy).toBe(0)
    expect(a.rubberStamping).toBe(true)
    expect(a.readyToEscalate).toBe(false)
    expect(a.flags.join(' ')).toMatch(/entropy|same reason/i)
  })

  it('flags high approval with perfunctory one-word reasons', () => {
    const codes = ['unblocks', 'cheap-win', 'sound-reasoning', 'known-problem']
    const a = assessEngagement(
      Array.from({ length: 12 }, (_, i) => rec({ code: codes[i % 4]!, text: 'sure ok fine' })),
    )
    expect(a.rubberStamping).toBe(true)
    expect(a.flags.join(' ')).toMatch(/effort|short/i)
  })

  it('blocks escalation when the human has never disagreed (Seldonian spirit)', () => {
    const codes = ['unblocks', 'cheap-win', 'sound-reasoning', 'known-problem']
    const a = assessEngagement(
      Array.from({ length: 12 }, (_, i) =>
        rec({
          code: codes[i % 4]!,
          text: 'a genuinely long and specific justification referencing the actual proposal content',
        }),
      ),
    )
    expect(a.disagreedRecently).toBe(false)
    expect(a.readyToEscalate).toBe(false)
    expect(a.flags.join(' ')).toMatch(/disagree/i)
  })
})

describe('assessEngagement — recognises genuine engagement', () => {
  const engaged: ReviewRecord[] = [
    rec({ verdict: 'reject', code: 'already-exists', text: 'the team-reaper already covers this path entirely' }),
    rec({ verdict: 'reject', code: 'premature', text: 'right idea but we have no propensity model yet so it is early' }),
    rec({ verdict: 'approve', code: 'unblocks', text: 'this clears the scheduler blocker i keep hitting every week' }),
    rec({ verdict: 'approve', code: 'sound-reasoning', text: 'the evidence about repeated bash invocations holds up' }),
    rec({ verdict: 'reject', code: 'mis-scoped', text: 'direction is right but this is far too large a first slice' }),
    rec({ verdict: 'approve', code: 'cheap-win', text: 'small enough that it is worth doing even if it only half works' }),
    rec({ verdict: 'reject', code: 'insufficient-evidence', text: 'two observations is not a pattern, come back with more' }),
  ]

  it('does not flag a varied, substantive history', () => {
    const a = assessEngagement(engaged)
    expect(a.sufficientData).toBe(true)
    expect(a.rubberStamping).toBe(false)
    expect(a.disagreedRecently).toBe(true)
    expect(a.readyToEscalate).toBe(true)
    expect(a.flags).toHaveLength(0)
  })

  it('allows a high approval rate when reasons stay diverse and substantive', () => {
    const mostlyYes = [
      ...engaged.filter((r) => r.verdict === 'approve'),
      rec({ verdict: 'approve', code: 'known-problem', text: 'fixes the context-rot issue i reported a fortnight ago' }),
      rec({ verdict: 'reject', code: 'risky', text: 'touches the allowlist which stays human-owned, absolutely not' }),
    ]
    const a = assessEngagement(mostlyYes)
    expect(a.approvalRate).toBeGreaterThan(0.7)
    expect(a.rubberStamping).toBe(false)
  })

  it('reports the metrics it judged on, so the verdict is auditable', () => {
    const a = assessEngagement(engaged)
    expect(a.n).toBe(engaged.length)
    expect(a.meanReasonLength).toBeGreaterThan(0)
    expect(a.reasonEntropy).toBeGreaterThan(0)
  })
})

describe('assessEngagement — a reason-free history can never certify readiness', () => {
  it('treats missing codes as maximum concentration, not as diversity', () => {
    const a = assessEngagement(Array.from({ length: 12 }, () => rec({ code: null, text: 'ok' })))
    expect(a.rubberStamping).toBe(true)
    expect(a.readyToEscalate).toBe(false)
  })
})

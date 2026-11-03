import { describe, it, expect } from 'vitest'
import {
  feedbackEnabledFromEnv,
  titleFamily,
  buildPriorOutcomes,
  linkOutcomes,
  applyLinkedOutcomes,
  type RealizedOutcomes,
} from '../../../src/ideate/feedback.js'
import type { IdeationRecord } from '../../../src/ideate/types.js'

const REALIZED: RealizedOutcomes = {
  implemented: ['Add per-call metrics for the busiest tool: bash'],
  rejected: ['Add a flaky retry shim'],
  failed: ['Add an integration smoke test for the autonomy module'],
}

function rec(id: string, title: string, outcome: IdeationRecord['outcome'] = null): IdeationRecord {
  return {
    id,
    title,
    rationale: 'r',
    expectedValue: 'v',
    implementationSketch: 's',
    testableSuccessCriterion: 'c',
    createdAt: new Date().toISOString(),
    source: 'synth-ideation',
    model: 'synth',
    status: 'new',
    outcome,
  }
}

const UUID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

describe('feedbackEnabledFromEnv', () => {
  it('is default-OFF', () => expect(feedbackEnabledFromEnv({})).toBe(false))
  it('on when SCNS_IDEATE_FEEDBACK=1', () =>
    expect(feedbackEnabledFromEnv({ SCNS_IDEATE_FEEDBACK: '1' })).toBe(true))
})

describe('titleFamily', () => {
  it('normalizes case + caps at 6 words', () => {
    expect(titleFamily('Add Per-call Metrics For The Busiest Tool: bash')).toBe(
      'add per-call metrics for the busiest',
    )
  })
})

describe('linkOutcomes', () => {
  it('stamps open records matching a realized fate', () => {
    const out = linkOutcomes(
      [rec(UUID(1), 'Add per-call metrics for the busiest tool: bash')],
      REALIZED,
      () => new Date('2026-01-01T00:00:00Z'),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.outcome.result).toBe('implemented')
    expect(out[0]!.outcome.recordedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('maps failed→no-action, rejected→rejected', () => {
    const out = linkOutcomes(
      [rec(UUID(2), 'Add an integration smoke test for the autonomy module'), rec(UUID(3), 'Add a flaky retry shim')],
      REALIZED,
    )
    const byId = Object.fromEntries(out.map((o) => [o.id, o.outcome.result]))
    expect(byId[UUID(2)]).toBe('no-action')
    expect(byId[UUID(3)]).toBe('rejected')
  })

  it('skips records that already have an outcome', () => {
    const stamped = rec(UUID(1), 'Add per-call metrics for the busiest tool: bash', {
      result: 'implemented',
      detail: '',
      recordedAt: new Date().toISOString(),
    })
    expect(linkOutcomes([stamped], REALIZED)).toHaveLength(0)
  })

  it('returns nothing when no families match', () => {
    expect(linkOutcomes([rec(UUID(4), 'Totally unrelated idea')], REALIZED)).toHaveLength(0)
  })
})

describe('buildPriorOutcomes', () => {
  it('emits only outcome-bearing records', () => {
    const prior = buildPriorOutcomes([
      rec(UUID(1), 'kept', { result: 'merged', detail: '', recordedAt: new Date().toISOString() }),
      rec(UUID(2), 'open'),
    ])
    expect(prior).toEqual([{ title: 'kept', outcome: 'merged' }])
  })
})

describe('applyLinkedOutcomes', () => {
  it('persists via inbox.markOutcome and counts stamps', () => {
    const records = [rec(UUID(1), 'Add per-call metrics for the busiest tool: bash')]
    const calls: string[] = []
    const inbox = {
      list: () => records,
      markOutcome: (id: string) => {
        calls.push(id)
        return null
      },
      append: () => [],
      get: () => null,
      setStatus: () => null,
    }
    expect(applyLinkedOutcomes(inbox, REALIZED)).toBe(1)
    expect(calls).toEqual([UUID(1)])
  })
})

import { describe, it, expect } from 'vitest'
import {
  computeTaskSignature,
  decideShape,
  type ScalingOutcome,
} from '../../../src/brain/scaling-policy.js'

describe('computeTaskSignature', () => {
  it('produces identical signatures for semantically-identical rewordings', () => {
    const a = computeTaskSignature('add rate-limit feature to the broker module')
    const b = computeTaskSignature('Add Rate-Limit feature to the Broker module.')
    const c = computeTaskSignature('rate-limit broker module add feature')
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it('produces distinct signatures for unrelated tasks', () => {
    const a = computeTaskSignature('add rate-limit feature to broker module')
    const b = computeTaskSignature('refactor pdf skill prompt handling for clarity')
    expect(a).not.toBe(b)
  })

  it('is deterministic across calls', () => {
    const desc = 'ship otel ingestion metrics to dashboard'
    expect(computeTaskSignature(desc)).toBe(computeTaskSignature(desc))
  })

  it('handles empty/stopword-only input without crashing', () => {
    const a = computeTaskSignature('')
    const b = computeTaskSignature('the and of')
    expect(a).toMatch(/^sig:/)
    expect(b).toMatch(/^sig:/)
  })
})

function outcome(sig: string, shape: 'solo' | 'team', success: boolean, quality?: number): ScalingOutcome {
  return {
    task_signature: sig,
    spawned_as: shape,
    success: success ? 1 : 0,
    duration_ms: 1000,
    quality_score: quality ?? null,
  }
}

describe('decideShape', () => {
  const description = 'add caching layer to memory vault lookups'

  it('defers to the team hint when history is empty', () => {
    const d = decideShape({ description, hint: 'team', suggestedRoles: ['impl', 'rev'], history: [] })
    expect(d.shape).toBe('team')
    expect(d.roles).toEqual(['impl', 'rev'])
    expect(d.reasoning).toMatch(/insufficient history/i)
    expect(d.hintShape).toBe('team')
  })

  it('defers to the solo hint when history is empty', () => {
    const d = decideShape({ description, hint: 'solo', history: [] })
    expect(d.shape).toBe('solo')
    expect(d.roles).toEqual([])
    expect(d.reasoning).toMatch(/insufficient history/i)
  })

  it('overrides team→solo when historical solo successes dominate for that signature', () => {
    const sig = computeTaskSignature(description)
    const history: ScalingOutcome[] = [
      outcome(sig, 'solo', true, 0.9),
      outcome(sig, 'solo', true, 0.85),
      outcome(sig, 'solo', true, 0.8),
    ]
    const d = decideShape({ description, hint: 'team', suggestedRoles: ['impl'], history })
    expect(d.shape).toBe('solo')
    expect(d.roles).toEqual([])
    expect(d.reasoning).toMatch(/override team.*solo/i)
  })

  it('overrides team→solo when team history shows low quality and solo has a success', () => {
    const sig = computeTaskSignature(description)
    const history: ScalingOutcome[] = [
      outcome(sig, 'team', true, 0.4),
      outcome(sig, 'team', true, 0.3),
      outcome(sig, 'team', false, 0.2),
      outcome(sig, 'solo', true, 0.75),
    ]
    const d = decideShape({ description, hint: 'team', suggestedRoles: ['impl'], history })
    expect(d.shape).toBe('solo')
    expect(d.reasoning).toMatch(/override team.*solo/i)
    expect(d.reasoning).toMatch(/quality/i)
  })

  it('ignores history rows with non-matching signatures', () => {
    const otherSig = 'sig:0000000000000000'
    const history: ScalingOutcome[] = [
      outcome(otherSig, 'solo', true, 0.9),
      outcome(otherSig, 'solo', true, 0.9),
      outcome(otherSig, 'solo', true, 0.9),
    ]
    const d = decideShape({ description, hint: 'team', suggestedRoles: ['impl'], history })
    expect(d.shape).toBe('team')
    expect(d.historyCount).toBe(0)
  })

  it('upgrades solo→team when solo has 3+ failures and team has a high-quality success', () => {
    const sig = computeTaskSignature(description)
    const history: ScalingOutcome[] = [
      outcome(sig, 'solo', false),
      outcome(sig, 'solo', false),
      outcome(sig, 'solo', false),
      outcome(sig, 'team', true, 0.85),
    ]
    const d = decideShape({ description, hint: 'solo', suggestedRoles: ['impl', 'rev'], history })
    expect(d.shape).toBe('team')
    expect(d.roles.length).toBeGreaterThan(0)
    expect(d.reasoning).toMatch(/override solo.*team/i)
  })

  it('keeps solo when hint is solo and solo history is healthy', () => {
    const sig = computeTaskSignature(description)
    const history: ScalingOutcome[] = [
      outcome(sig, 'solo', true, 0.9),
      outcome(sig, 'solo', true, 0.9),
      outcome(sig, 'solo', true, 0.9),
    ]
    const d = decideShape({ description, hint: 'solo', history })
    expect(d.shape).toBe('solo')
    expect(d.reasoning).toMatch(/defer/i)
  })

  it('treats "complex" hint as team for decision purposes', () => {
    const d = decideShape({ description, hint: 'complex', suggestedRoles: ['impl'], history: [] })
    expect(d.shape).toBe('team')
    expect(d.hintShape).toBe('team')
  })
})

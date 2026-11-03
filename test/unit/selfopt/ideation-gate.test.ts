import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { recordProposalOutcome } from '../../../src/memory/proposal-outcomes.js'
import {
  resolveIdeationGateMode,
  evaluateIdeationGate,
  familyLandingStats,
  IDEATION_GATE_ENV,
  IDEATION_GATE_ENFORCE_ENV,
} from '../../../src/selfopt/ideation-gate.js'
import type Database from 'better-sqlite3'

describe('resolveIdeationGateMode', () => {
  it('is doubly default-OFF and parses each env opt-in independently', () => {
    expect(resolveIdeationGateMode({})).toEqual({ measure: false, enforce: false })
    expect(resolveIdeationGateMode({ [IDEATION_GATE_ENV]: '1' })).toEqual({
      measure: true,
      enforce: false,
    })
    expect(
      resolveIdeationGateMode({ [IDEATION_GATE_ENV]: 'true', [IDEATION_GATE_ENFORCE_ENV]: 'yes' }),
    ).toEqual({ measure: true, enforce: true })
    // enforce alone (without measure) is inert at the call site but still parsed
    expect(resolveIdeationGateMode({ [IDEATION_GATE_ENFORCE_ENV]: '1' })).toEqual({
      measure: false,
      enforce: true,
    })
  })
})

describe('evaluateIdeationGate', () => {
  it('is inert (delta 0, not regressed) when no family has outcome history (neutral prior)', () => {
    const r = evaluateIdeationGate({
      baselineFamilies: ['static-a', 'static-b'],
      candidateFamilies: ['mem-a', 'mem-b'],
      familyStats: new Map(),
    })
    expect(r.ran).toBe(true)
    expect(r.baselineScore).toBe(0.5)
    expect(r.candidateScore).toBe(0.5)
    expect(r.delta).toBe(0)
    expect(r.regressed).toBe(false)
  })

  it('does not regress when the candidate families have a higher landing rate', () => {
    const r = evaluateIdeationGate({
      baselineFamilies: ['static-a'],
      candidateFamilies: ['mem-a'],
      familyStats: new Map([['mem-a', { landed: 3, failed: 0 }]]),
    })
    expect(r.candidateScore).toBe(1)
    expect(r.baselineScore).toBe(0.5)
    expect(r.delta).toBeCloseTo(0.5, 9)
    expect(r.regressed).toBe(false)
  })

  it('flags a regression when the candidate families keep failing vs the baseline prior', () => {
    const r = evaluateIdeationGate({
      baselineFamilies: ['static-a'],
      candidateFamilies: ['mem-a'],
      familyStats: new Map([['mem-a', { landed: 0, failed: 3 }]]),
    })
    expect(r.candidateScore).toBe(0)
    expect(r.baselineScore).toBe(0.5)
    expect(r.delta).toBeCloseTo(-0.5, 9)
    expect(r.regressed).toBe(true)
  })

  it('skips (ran=false) when there are no families to score', () => {
    const r = evaluateIdeationGate({
      baselineFamilies: [],
      candidateFamilies: [],
      familyStats: new Map(),
    })
    expect(r.ran).toBe(false)
    expect(r.skipReason).toBe('no-families')
  })

  it('reports per-family rates with a seen flag', () => {
    const r = evaluateIdeationGate({
      baselineFamilies: ['static-a'],
      candidateFamilies: ['mem-a'],
      familyStats: new Map([['mem-a', { landed: 1, failed: 1 }]]),
    })
    const mem = r.perFamily.find((p) => p.family === 'mem-a')!
    expect(mem.seen).toBe(true)
    expect(mem.rate).toBe(0.5)
    const stat = r.perFamily.find((p) => p.family === 'static-a')!
    expect(stat.seen).toBe(false)
  })
})

describe('familyLandingStats', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => {
    closeMemoryDb(db)
  })

  it('aggregates landed/failed per family across entities', () => {
    recordProposalOutcome(db, { entity: 'broker', family: 'fam-x', title: 't', verdict: 'implemented', suggestionId: 'a' })
    recordProposalOutcome(db, { entity: 'vault', family: 'fam-x', title: 't', verdict: 'failed', suggestionId: 'b' })
    recordProposalOutcome(db, { entity: 'broker', family: 'fam-y', title: 't', verdict: 'rejected', suggestionId: 'c' })
    const stats = familyLandingStats(db)
    // FR-059 — `failed` means "the machine could not BUILD this", not "the human refused it", so it
    // is not a family failure. This assertion used to read `{ landed: 1, failed: 1 }` because this
    // scorer carried its own hardcoded `('failed','rejected','reverted')` list, a second definition
    // of "failure verdict" that FR-059 did not reach; it now derives from `FAILED_VERDICTS`.
    // `fam-y` is unchanged: `rejected` IS the human refusing, and still counts.
    expect(stats.get('fam-x')).toEqual({ landed: 1, failed: 0 })
    expect(stats.get('fam-y')).toEqual({ landed: 0, failed: 1 })
  })

  it('FR-059: build failures alone never accumulate into family suppression', () => {
    // Phase 10f makes `failed` the routine product of every gate failure, so this is the shape
    // that would otherwise silently suppress a family the human never declined.
    for (const id of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      recordProposalOutcome(db, { entity: 'broker', family: 'fam-build', title: 't', verdict: 'failed', suggestionId: id })
    }
    expect(familyLandingStats(db).get('fam-build')).toEqual({ landed: 0, failed: 0 })
  })

  it('returns an empty map when the table is absent (side-effect-free)', () => {
    const bare = openMemoryDb(':memory:')
    bare.exec('DROP TABLE IF EXISTS proposal_outcomes')
    expect(familyLandingStats(bare).size).toBe(0)
    closeMemoryDb(bare)
  })
})

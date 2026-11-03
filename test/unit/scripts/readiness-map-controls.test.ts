/**
 * T010 [US1] (feature 002) — the AUDIT's positive + negative controls, encoded as fixtures the readiness
 * validator must classify correctly (R4 audit method: a readiness audit needs a known-usable positive
 * control AND a known-code-complete negative control, or its "usable" grades are unfalsifiable).
 *
 *  • POSITIVE control — `safe_outward` with a real deny-all/fail-closed evidence row + passing pos/neg
 *    controls MUST be accepted as `usable`.
 *  • NEGATIVE control — `self_learning`'s per-attempt experience APIs with ZERO live callers MUST grade
 *    ≤ `built`: graded `built` it is valid, but any attempt to grade it `usable` (no live-e2e row) MUST
 *    be rejected by the validator. Code-complete is not usable.
 */
import { describe, it, expect } from 'vitest'
import {
  validateReadinessMap,
  type ReadinessMap,
  type CapabilityAssessment,
} from '../../../scripts/lib/readiness-map.js'

/** POSITIVE control: safe outward operation — deny-all, fail-closed, kernel untouched (fable5 §5.1). */
function safeOutwardUsable(): CapabilityAssessment {
  return {
    capability_id: 'safe_outward',
    state: 'usable',
    gap: 'none material — guardrails live and fail-closed; hardening only',
    backing_subsystems: ['src/broker/services/outward', 'config/safety-allowlist.json'],
    evidence: [
      {
        claim:
          'an outward action with an empty allowlist is denied (fail-closed), kernel untouched',
        quoted_output:
          'outward.send → DENIED (allowlist empty; fail-closed); kernel bytes unchanged',
        artifact_ref: 'docs/evidence/fable5-audit-findings.md',
      },
    ],
    controls: { positive: true, negative: true, separation: 1.0 },
    blocked: null,
  }
}

/** NEGATIVE control: per-attempt experience APIs exist but have 0 live callers (fable5 §5.2). */
function experienceApisBuilt(): CapabilityAssessment {
  return {
    capability_id: 'self_learning',
    state: 'built',
    gap: 'per-attempt experience APIs (recordAttempt/…) have 0 live callers — code-complete, not wired live',
    backing_subsystems: ['src/reward/experience-store.ts', 'src/memory/arm-router.ts'],
    evidence: [],
    controls: { positive: false, negative: false, separation: 0 },
    blocked: null,
  }
}

function fillerBuilt(id: string): CapabilityAssessment {
  return {
    capability_id: id,
    state: 'built',
    gap: `distance to usable for ${id} named by its auditor`,
    backing_subsystems: ['src/example'],
    evidence: [],
    controls: { positive: false, negative: false, separation: 0 },
    blocked: null,
  }
}

function mapWith(...caps: CapabilityAssessment[]): ReadinessMap {
  return {
    generated_in_context: 'ctx-producer',
    signoff: { producer_context_id: 'ctx-producer', grader_context_id: 'ctx-grader', agreed: true },
    capabilities: caps,
    prioritized_gap_map: [
      {
        capability_id: 'self_direction',
        priority: 1,
        missing_pieces: ['scheduler'],
        blocks: ['autonomy'],
      },
    ],
    magma_placement: 'US2 placed in the gap map',
    distance_summary: 'honest distance: mostly built, one capability usable',
  }
}

describe('T010 — audit POSITIVE control (safe_outward grades usable)', () => {
  it('a real deny-all/fail-closed evidence row + both controls is accepted as usable', () => {
    const map = mapWith(
      safeOutwardUsable(),
      experienceApisBuilt(),
      fillerBuilt('trustworthy_recall'),
      fillerBuilt('self_direction'),
    )
    expect(validateReadinessMap(map)).toEqual([])
  })

  it('the positive control BITES: strip its evidence and "usable" is rejected (no unfalsifiable pass)', () => {
    const stripped = safeOutwardUsable()
    stripped.evidence = []
    const map = mapWith(
      stripped,
      experienceApisBuilt(),
      fillerBuilt('trustworthy_recall'),
      fillerBuilt('self_direction'),
    )
    expect(validateReadinessMap(map).join(' ')).toMatch(/safe_outward.*usable.*evidence/i)
  })
})

describe('T010 — audit NEGATIVE control (per-attempt experience APIs grade ≤ built)', () => {
  it('graded `built` with 0 live callers, it is a VALID honest assessment', () => {
    const map = mapWith(
      safeOutwardUsable(),
      experienceApisBuilt(),
      fillerBuilt('trustworthy_recall'),
      fillerBuilt('self_direction'),
    )
    const problems = validateReadinessMap(map)
    expect(problems).toEqual([])
    const sl = map.capabilities.find((c) => c.capability_id === 'self_learning')!
    expect(sl.state).toBe('built') // ≤ built, never usable
  })

  it('over-grading the negative control to `usable` (no live caller) MUST be rejected', () => {
    const overGraded = experienceApisBuilt()
    overGraded.state = 'usable' // the exact over-claim the audit must never make
    const map = mapWith(
      safeOutwardUsable(),
      overGraded,
      fillerBuilt('trustworthy_recall'),
      fillerBuilt('self_direction'),
    )
    expect(validateReadinessMap(map).join(' ')).toMatch(/self_learning.*usable.*evidence/i)
  })

  it('the two controls are SEPARATED: the positive is usable, the negative is not, in one valid map', () => {
    const map = mapWith(
      safeOutwardUsable(),
      experienceApisBuilt(),
      fillerBuilt('trustworthy_recall'),
      fillerBuilt('self_direction'),
    )
    expect(validateReadinessMap(map)).toEqual([])
    const usable = map.capabilities.filter((c) => c.state === 'usable').map((c) => c.capability_id)
    expect(usable).toEqual(['safe_outward'])
  })
})

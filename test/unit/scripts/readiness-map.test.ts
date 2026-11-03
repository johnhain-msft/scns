/**
 * T009 [US1] (feature 002) — RED-FIRST schema validation for the Readiness Map output
 * (contracts/readiness-map.schema.md, data-model §1). The validator is the tripwire that makes an
 * over-claimed audit un-shippable: it MUST reject a `usable` state with no live-evidence row, reject a
 * self-signed verdict (producer == grader), and require all five capabilities. Written before the
 * validator exists (red), green after `scripts/lib/readiness-map.ts` lands.
 *
 * Every rule carries a POSITIVE control (a valid map passes) and a NEGATIVE control (the violation is
 * caught) — a schema that cannot reject is not a schema.
 */
import { describe, it, expect } from 'vitest'
import {
  validateReadinessMap,
  CAPABILITY_IDS,
  type ReadinessMap,
  type CapabilityAssessment,
} from '../../../scripts/lib/readiness-map.js'

function usableCapability(id: string): CapabilityAssessment {
  return {
    capability_id: id,
    state: 'usable',
    gap: 'none material; hardening only',
    backing_subsystems: ['src/example'],
    evidence: [
      {
        claim: 'live end-to-end proof',
        quoted_output: 'PASS ✓ real quoted row',
        artifact_ref: 'docs/evidence/audit/example.md:12',
      },
    ],
    controls: { positive: true, negative: true, separation: 1.0 },
    blocked: null,
  }
}

function builtCapability(id: string): CapabilityAssessment {
  return {
    capability_id: id,
    state: 'built',
    gap: 'code-complete but no live caller — not wired into the running system',
    backing_subsystems: ['src/example'],
    evidence: [],
    controls: { positive: false, negative: false, separation: 0 },
    blocked: null,
  }
}

/** A fully valid map: every capability present once, honest states, independent sign-off. */
function validMap(): ReadinessMap {
  return {
    generated_in_context: 'ctx-A',
    signoff: { producer_context_id: 'ctx-A', grader_context_id: 'ctx-B', agreed: true },
    capabilities: [
      usableCapability('safe_outward'),
      builtCapability('trustworthy_recall'),
      builtCapability('self_learning'),
      builtCapability('self_direction'),
      builtCapability('voice_cloning'),
    ],
    prioritized_gap_map: [
      { capability_id: 'self_direction', priority: 1, missing_pieces: ['scheduler'], blocks: ['autonomy'] },
      { capability_id: 'trustworthy_recall', priority: 2, missing_pieces: ['magma fix'], blocks: ['recall'] },
    ],
    magma_placement: 'US2 sits at priority 2 (trustworthy_recall measured-with-controls gap)',
    distance_summary: 'far from usable overall; safe_outward is the only usable capability today',
  }
}

describe('validateReadinessMap — coverage (SC-001)', () => {
  it('POSITIVE: a valid map with all five capabilities returns zero problems', () => {
    expect(validateReadinessMap(validMap())).toEqual([])
  })

  it('exposes exactly the five north-star capability ids', () => {
    expect([...CAPABILITY_IDS].sort()).toEqual(
      ['safe_outward', 'self_direction', 'self_learning', 'trustworthy_recall', 'voice_cloning'].sort(),
    )
  })

  it('NEGATIVE: a missing capability is rejected', () => {
    const m = validMap()
    m.capabilities = m.capabilities.filter((c) => c.capability_id !== 'voice_cloning')
    expect(validateReadinessMap(m).join(' ')).toMatch(/voice_cloning|coverage|5 capabilit/i)
  })

  it('NEGATIVE: a duplicated capability is rejected', () => {
    const m = validMap()
    m.capabilities[1] = usableCapability('safe_outward') // safe_outward twice
    expect(validateReadinessMap(m).join(' ')).toMatch(/duplicat|once/i)
  })
})

describe('validateReadinessMap — no unproven usable (SC-002, FR-002)', () => {
  it('NEGATIVE: usable with an empty evidence[] is rejected (over-claim)', () => {
    const m = validMap()
    const cap = m.capabilities.find((c) => c.capability_id === 'safe_outward')!
    cap.evidence = []
    expect(validateReadinessMap(m).join(' ')).toMatch(/usable.*evidence|evidence.*usable/i)
  })

  it('NEGATIVE: usable with a blank quoted_output is rejected', () => {
    const m = validMap()
    const cap = m.capabilities.find((c) => c.capability_id === 'safe_outward')!
    cap.evidence = [{ claim: 'x', quoted_output: '   ', artifact_ref: 'a:1' }]
    expect(validateReadinessMap(m).join(' ')).toMatch(/quoted_output|verbatim|live-e2e/i)
  })

  it('NEGATIVE: usable without BOTH controls passing is rejected', () => {
    const m = validMap()
    const cap = m.capabilities.find((c) => c.capability_id === 'safe_outward')!
    cap.controls = { positive: true, negative: false, separation: 1.0 }
    expect(validateReadinessMap(m).join(' ')).toMatch(/control/i)
  })

  it('POSITIVE: a built capability with no evidence is fine (code-complete is honestly ≤ built)', () => {
    const m = validMap()
    // all four non-usable capabilities are `built` with empty evidence — must NOT be flagged
    expect(validateReadinessMap(m)).toEqual([])
  })
})

describe('validateReadinessMap — BLOCKED not faked (FR-003)', () => {
  it('POSITIVE: a blocked capability with could_setup_show_win:false + a named precondition passes', () => {
    const m = validMap()
    const cap = m.capabilities.find((c) => c.capability_id === 'self_direction')!
    cap.blocked = { missing_precondition: 'no scheduler subsystem exists', could_setup_show_win: false }
    expect(validateReadinessMap(m)).toEqual([])
  })

  it('NEGATIVE: a blocked result with an empty missing_precondition is rejected', () => {
    const m = validMap()
    const cap = m.capabilities.find((c) => c.capability_id === 'self_direction')!
    cap.blocked = { missing_precondition: '', could_setup_show_win: false }
    expect(validateReadinessMap(m).join(' ')).toMatch(/missing_precondition/i)
  })
})

describe('validateReadinessMap — independent sign-off (SC-003, FR-004)', () => {
  it('NEGATIVE: producer == grader is rejected (self-graded verdict)', () => {
    const m = validMap()
    m.signoff = { producer_context_id: 'ctx-A', grader_context_id: 'ctx-A', agreed: true }
    expect(validateReadinessMap(m).join(' ')).toMatch(/producer.*grader|self-graded|independent/i)
  })

  it('NEGATIVE: agreed:false is rejected', () => {
    const m = validMap()
    m.signoff = { producer_context_id: 'ctx-A', grader_context_id: 'ctx-B', agreed: false }
    expect(validateReadinessMap(m).join(' ')).toMatch(/agreed|sign-?off/i)
  })
})

describe('validateReadinessMap — actionable + honesty (FR-005, SC-012)', () => {
  it('NEGATIVE: an empty prioritized_gap_map is rejected', () => {
    const m = validMap()
    m.prioritized_gap_map = []
    expect(validateReadinessMap(m).join(' ')).toMatch(/gap map|prioriti/i)
  })

  it('NEGATIVE: an empty magma_placement or distance_summary is rejected', () => {
    const m1 = validMap()
    m1.magma_placement = ''
    expect(validateReadinessMap(m1).join(' ')).toMatch(/magma_placement/i)
    const m2 = validMap()
    m2.distance_summary = ''
    expect(validateReadinessMap(m2).join(' ')).toMatch(/distance_summary/i)
  })

  it('NEGATIVE: a bare "yes" distance_summary while capabilities are not all usable is rejected', () => {
    const m = validMap()
    m.distance_summary = 'Yes — the north star is reached.'
    expect(validateReadinessMap(m).join(' ')).toMatch(/honest|not all.*usable|inflated/i)
  })
})

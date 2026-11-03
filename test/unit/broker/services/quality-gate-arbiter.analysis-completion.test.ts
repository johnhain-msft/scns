import { describe, it, expect } from 'vitest'
import { isAnalysisCompletion } from '../../../../src/broker/services/quality-gate-arbiter.js'

/**
 * The QG no-diff branch judges an analysis/research team by the claim-evidence
 * verifier instead of auto-failing it for producing no code diff. Before the
 * role bridge, isAnalysisCompletion keyed ONLY on the broker role
 * `scns-researcher`, so a brain-namespace `researcher` (what the planner +
 * suggestion paths emit via assignRole) was not recognized and its findings-only
 * output hit the no-diff auto-FAIL. The bridge closes that fracture.
 */
describe('isAnalysisCompletion — role-bridge recognition', () => {
  it('recognizes the canonical broker researcher role', () => {
    expect(isAnalysisCompletion([{ role: 'scns-researcher' }])).toBe(true)
  })

  it('recognizes the brain-namespace researcher role (bridge)', () => {
    expect(isAnalysisCompletion([{ role: 'researcher' }])).toBe(true)
  })

  it('recognizes a researcher among a mixed team', () => {
    expect(
      isAnalysisCompletion([{ role: 'scns-dev' }, { role: 'researcher' }, { role: 'scns-qa' }]),
    ).toBe(true)
  })

  it('is false for a code-only team (no researcher in either namespace)', () => {
    expect(isAnalysisCompletion([{ role: 'scns-dev' }, { role: 'implementer' }])).toBe(false)
    expect(isAnalysisCompletion([])).toBe(false)
  })
})

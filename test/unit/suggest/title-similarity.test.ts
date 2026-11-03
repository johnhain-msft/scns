import { describe, it, expect } from 'vitest'
import { normalizeTitle, titleSimilarity, subsumes } from '../../../src/suggest/title-similarity.js'

describe('titleSimilarity', () => {
  it('ignores case and punctuation', () => {
    expect(titleSimilarity('Create CI/CD workflow', 'create cicd workflow')).toBe(1)
  })

  // POSITIVE CONTROL: the real pair that reached John twice — same project, one is a superset.
  it('scores a modifier-only variant as a near-duplicate', () => {
    const s = titleSimilarity(
      'Create CI/CD workflow for scns',
      'Create CI/CD with test workflow for scns',
    )
    expect(s).toBeGreaterThanOrEqual(0.7)
  })

  // NEGATIVE CONTROL: same shape, DIFFERENT subject — these are two real, separate proposals.
  it('keeps proposals for different projects apart', () => {
    const s = titleSimilarity(
      'Create CI/CD workflow for scns',
      'Create CI/CD workflow for hermes-agent',
    )
    expect(s).toBeLessThan(0.7)
  })

  it('is symmetric and bounded', () => {
    const a = 'Create Terminal helper skill'
    const b = 'Install Terminal MCP integration'
    expect(titleSimilarity(a, b)).toBe(titleSimilarity(b, a))
    expect(titleSimilarity(a, b)).toBeGreaterThanOrEqual(0)
    expect(titleSimilarity(a, b)).toBeLessThanOrEqual(1)
  })

  it('returns 0 for two empty titles rather than dividing by zero', () => {
    expect(titleSimilarity('', '')).toBe(0)
  })

  it('normalizes to bare words', () => {
    expect([...normalizeTitle('Create CI/CD workflow!')]).toEqual(['create', 'cicd', 'workflow'])
  })
})

describe('subsumes — the sibling rule, which similarity alone got wrong', () => {
  it('collapses a title that is a pure superset of another (modifier only)', () => {
    expect(subsumes('Create CI/CD workflow for scns', 'Create CI/CD with test workflow for scns')).toBe(true)
  })

  // THE REAL REGRESSION: Jaccard scored these 0.750 and silently deleted both hermes-agent and
  // lethe CI/CD proposals. Different SUBJECT, so they are not siblings at any similarity.
  it('never collapses two different projects, however similar the wording', () => {
    expect(
      subsumes('Create CI/CD with test workflow for hermes-agent', 'Create CI/CD with test workflow for lethe'),
    ).toBe(false)
    expect(subsumes('Create CI/CD workflow for scns', 'Create CI/CD workflow for hermes-agent')).toBe(false)
    expect(
      subsumes('Add default model preference for claude-opus-4.8', 'Add default model preference for claude-opus-5'),
    ).toBe(false)
  })

  it('collapses the preferred-tools variants that really are subsets', () => {
    expect(
      subsumes('Add preferred tools instruction (bash, view)', 'Add preferred tools instruction (bash, view, edit, rg, create)'),
    ).toBe(true)
  })

  it('does not collapse two variants that each have a token the other lacks', () => {
    expect(
      subsumes('Add preferred tools instruction (view, grep)', 'Add preferred tools instruction (bash, view)'),
    ).toBe(false)
  })

  it('refuses to collapse on trivially short titles', () => {
    expect(subsumes('Fix it', 'Fix it now please')).toBe(false)
  })

  it('is symmetric', () => {
    const a = 'Create CI/CD workflow for scns'
    const b = 'Create CI/CD with test workflow for scns'
    expect(subsumes(a, b)).toBe(subsumes(b, a))
  })
})

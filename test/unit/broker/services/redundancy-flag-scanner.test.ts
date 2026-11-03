import { describe, it, expect } from 'vitest'
import {
  scanRedundancyFlags,
  hasAddressingExplanation,
  evaluateRedundancy,
} from '../../../../src/broker/services/redundancy-flag-scanner.js'

describe('redundancy-flag-scanner', () => {
  describe('scanRedundancyFlags', () => {
    it('finds nothing in clean output', () => {
      expect(scanRedundancyFlags('Added a new feature and tests. All green.')).toEqual([])
      expect(scanRedundancyFlags('')).toEqual([])
    })

    it('detects the build-redundancy vocabulary', () => {
      const flags = scanRedundancyFlags(
        'This duplicates assignRole and re-implements the same regex; a parallel implementation.',
      )
      const phrases = flags.map((f) => f.phrase)
      expect(phrases).toContain('duplicates')
      expect(phrases.some((p) => p.startsWith('re-implement') || p.startsWith('reimplement'))).toBe(
        true,
      )
      expect(phrases).toContain('parallel implementation')
    })

    it('does not trip on an innocuous "feature exists" mention', () => {
      // "already exists" IS a signal, but a plain feature mention is not.
      expect(scanRedundancyFlags('The dashboard shows the current status.')).toEqual([])
    })

    it('caps the number of flags returned', () => {
      const noisy = Array(50).fill('duplicate redundant reimplement reinvent').join(' ')
      expect(scanRedundancyFlags(noisy).length).toBeLessThanOrEqual(10)
    })
  })

  describe('hasAddressingExplanation', () => {
    it('recognizes reuse / distinctness / deletion justifications', () => {
      expect(hasAddressingExplanation('I reused the existing assignRole helper.')).toBe(true)
      expect(hasAddressingExplanation('This is distinct from the existing path because…')).toBe(true)
      expect(hasAddressingExplanation('Deleted the duplicate classifier.')).toBe(true)
      expect(hasAddressingExplanation('single source of truth for the regex')).toBe(true)
    })

    it('is false when no justification is present', () => {
      expect(hasAddressingExplanation('This duplicates assignRole.')).toBe(false)
    })
  })

  describe('evaluateRedundancy', () => {
    it('passes clean output (no flags → no-op, model never consulted)', () => {
      const r = evaluateRedundancy('Implemented X with tests; nothing pre-existing.')
      expect(r.verdict).toBe('pass')
      expect(r.flags).toEqual([])
      expect(r.findings).toEqual([])
    })

    it('passes when a flag trips BUT an addressing explanation is present', () => {
      const r = evaluateRedundancy(
        'This looked similar to the existing assignRole, so I reused it instead of duplicating.',
      )
      expect(r.flags.length).toBeGreaterThan(0)
      expect(r.addressed).toBe(true)
      expect(r.verdict).toBe('pass')
    })

    it('needs-explanation when a flag trips with NO addressing explanation (the 647a985 case)', () => {
      const r = evaluateRedundancy(
        'Added a new research-role-classifier that duplicates assignRole’s regex. Tests pass.',
      )
      expect(r.verdict).toBe('needs-explanation')
      expect(r.addressed).toBe(false)
      expect(r.findings[0]).toMatch(/redundancy signal/i)
    })
  })
})

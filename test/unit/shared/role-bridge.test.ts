import { describe, it, expect } from 'vitest'
import {
  RESEARCHER_ROLE,
  normalizeAgentRole,
  isResearcherRole,
} from '../../../src/shared/role-bridge.js'

describe('role-bridge', () => {
  describe('normalizeAgentRole', () => {
    it('maps the brain researcher role to the canonical broker spawn-role', () => {
      expect(normalizeAgentRole('researcher')).toBe(RESEARCHER_ROLE)
      expect(RESEARCHER_ROLE).toBe('scns-researcher')
    })

    it('is idempotent — the canonical broker role maps to itself', () => {
      expect(normalizeAgentRole('scns-researcher')).toBe('scns-researcher')
    })

    it('passes broker roles through unchanged', () => {
      expect(normalizeAgentRole('scns-dev')).toBe('scns-dev')
      expect(normalizeAgentRole('scns-qa')).toBe('scns-qa')
      expect(normalizeAgentRole('scns-manager')).toBe('scns-manager')
    })

    it('passes unmapped brain roles through unchanged (researcher-only scope)', () => {
      expect(normalizeAgentRole('implementer')).toBe('implementer')
      expect(normalizeAgentRole('tester')).toBe('tester')
      expect(normalizeAgentRole('reviewer')).toBe('reviewer')
      expect(normalizeAgentRole('planner')).toBe('planner')
    })

    it('passes an unknown role through unchanged', () => {
      expect(normalizeAgentRole('helper')).toBe('helper')
      expect(normalizeAgentRole('')).toBe('')
    })
  })

  describe('isResearcherRole', () => {
    it('recognizes the researcher capability in both namespaces', () => {
      expect(isResearcherRole('researcher')).toBe(true)
      expect(isResearcherRole('scns-researcher')).toBe(true)
    })

    it('is false for non-researcher roles', () => {
      expect(isResearcherRole('scns-dev')).toBe(false)
      expect(isResearcherRole('implementer')).toBe(false)
      expect(isResearcherRole('scns-manager')).toBe(false)
      expect(isResearcherRole('')).toBe(false)
    })
  })
})

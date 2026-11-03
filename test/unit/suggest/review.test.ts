import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
import { createExecutor } from '../../../src/suggest/executor.js'
import { createReviewWorkflow } from '../../../src/suggest/review.js'
import { SuggestionStatus } from '../../../src/suggest/types.js'
import type { Suggestion } from '../../../src/suggest/types.js'

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'skill',
    title: 'Create git-commit helper skill',
    description: 'You frequently run the same git commit pattern.',
    status: 'pending',
    confidence: 0.85,
    evidence: [
      {
        source: 'tool-frequency',
        detail: 'Git used 45 times in last 7 days',
        observedAt: '2025-01-15T10:00:00Z',
        weight: 0.8,
      },
    ],
    tags: ['git', 'automation'],
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:00:00Z',
    ...overrides,
  }
}

describe('ReviewWorkflow', () => {
  let rootDir: string
  let skillsDir: string
  let automationsDir: string
  let store: ReturnType<typeof createSuggestionStore>
  let workflow: ReturnType<typeof createReviewWorkflow>

  function setup(autonomyLevel = 0) {
    store = createSuggestionStore({ rootDir })
    const executor = createExecutor({ autonomyLevel, skillsDir, automationsDir })
    workflow = createReviewWorkflow({ store, executor })
  }

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'scns-review-test-'))
    skillsDir = mkdtempSync(join(tmpdir(), 'scns-review-skills-'))
    automationsDir = mkdtempSync(join(tmpdir(), 'scns-review-auto-'))
    setup(0)
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(skillsDir, { recursive: true, force: true })
    rmSync(automationsDir, { recursive: true, force: true })
  })

  describe('approve', () => {
    it('updates pending suggestion status to approved', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      const result = workflow.approve(suggestion.id)

      expect(result.success).toBe(true)
      expect(result.suggestion).not.toBeNull()
      expect(result.suggestion!.status).toBe(SuggestionStatus.Approved)
    })

    it('stores the approval reason', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      const result = workflow.approve(suggestion.id, 'Looks useful')

      expect(result.suggestion!.reviewReason).toBe('Looks useful')
    })

    it('generates an implementation plan', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      const result = workflow.approve(suggestion.id)

      expect(result.plan).toBeDefined()
      expect(result.plan!.suggestionId).toBe(suggestion.id)
      expect(result.plan!.steps.length).toBeGreaterThan(0)
    })

    it('executes plan and updates to implemented at L2+', () => {
      setup(2)
      const suggestion = makeSuggestion()
      store.save(suggestion)
      const result = workflow.approve(suggestion.id)

      expect(result.execution).toBeDefined()
      expect(result.execution!.stepsCompleted).toBeGreaterThan(0)
      // Status should be updated to implemented
      const updated = store.get(suggestion.id)
      expect(updated!.status).toBe(SuggestionStatus.Implemented)
    })

    it('generates plan but does not execute at L0', () => {
      setup(0)
      const suggestion = makeSuggestion()
      store.save(suggestion)
      const result = workflow.approve(suggestion.id)

      expect(result.plan).toBeDefined()
      expect(result.execution).toBeUndefined()
      const updated = store.get(suggestion.id)
      expect(updated!.status).toBe(SuggestionStatus.Approved)
    })

    it('returns error for non-existent suggestion ID', () => {
      const result = workflow.approve('nonexistent-id')

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.suggestion).toBeNull()
    })

    it('returns error for already-approved suggestion', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      workflow.approve(suggestion.id)
      const result = workflow.approve(suggestion.id)

      expect(result.success).toBe(false)
      expect(result.error).toContain('not pending')
    })

    it('returns error for already-rejected suggestion', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      workflow.reject(suggestion.id, 'Not needed')
      const result = workflow.approve(suggestion.id)

      expect(result.success).toBe(false)
      expect(result.error).toContain('not pending')
    })
  })

  describe('reject', () => {
    it('updates pending suggestion status to rejected', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      const result = workflow.reject(suggestion.id, 'Not useful')

      expect(result.success).toBe(true)
      expect(result.suggestion).not.toBeNull()
      expect(result.suggestion!.status).toBe(SuggestionStatus.Rejected)
    })

    it('stores the rejection reason', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      const result = workflow.reject(suggestion.id, 'Duplicate functionality')

      expect(result.suggestion!.reviewReason).toBe('Duplicate functionality')
    })

    it('returns error for non-existent suggestion ID', () => {
      const result = workflow.reject('nonexistent-id', 'reason')

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.suggestion).toBeNull()
    })

    it('returns error for already-rejected suggestion', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      workflow.reject(suggestion.id, 'First rejection')
      const result = workflow.reject(suggestion.id, 'Second rejection')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not pending')
    })
  })

  describe('getSummary', () => {
    it('returns correct summary fields for a suggestion', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      const summary = workflow.getSummary(suggestion.id)

      expect(summary).not.toBeNull()
      expect(summary!.id).toBe(suggestion.id)
      expect(summary!.type).toBe(suggestion.type)
      expect(summary!.title).toBe(suggestion.title)
      expect(summary!.confidence).toBe(suggestion.confidence)
      expect(summary!.evidenceCount).toBe(suggestion.evidence.length)
      expect(summary!.createdAt).toBe(suggestion.createdAt)
      expect(summary!.tags).toEqual(suggestion.tags)
    })

    it('returns null for unknown ID', () => {
      const summary = workflow.getSummary('nonexistent')
      expect(summary).toBeNull()
    })
  })

  describe('listPending', () => {
    it('returns only pending suggestions', () => {
      const s1 = makeSuggestion({ id: '550e8400-e29b-41d4-a716-446655440001' })
      const s2 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440002',
        title: 'Another skill',
      })
      store.save(s1)
      store.save(s2)
      workflow.approve(s1.id)

      const pending = workflow.listPending()
      expect(pending).toHaveLength(1)
      expect(pending[0]!.id).toBe(s2.id)
    })

    it('returns empty array for empty store', () => {
      const pending = workflow.listPending()
      expect(pending).toHaveLength(0)
    })

    it('sorts summaries by confidence descending', () => {
      const s1 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440001',
        confidence: 0.5,
        title: 'Low conf',
      })
      const s2 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440002',
        confidence: 0.9,
        title: 'High conf',
      })
      const s3 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440003',
        confidence: 0.7,
        title: 'Mid conf',
      })
      store.save(s1)
      store.save(s2)
      store.save(s3)

      const pending = workflow.listPending()
      expect(pending).toHaveLength(3)
      expect(pending[0]!.confidence).toBe(0.9)
      expect(pending[1]!.confidence).toBe(0.7)
      expect(pending[2]!.confidence).toBe(0.5)
    })

    it('with typeFilter returns only matching type', () => {
      const s1 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440001',
        type: 'skill',
        title: 'Skill suggestion',
      })
      const s2 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440002',
        type: 'prompt',
        title: 'Prompt suggestion',
      })
      const s3 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440003',
        type: 'skill',
        title: 'Another skill suggestion',
      })
      store.save(s1)
      store.save(s2)
      store.save(s3)

      const filtered = workflow.listPending('skill')
      expect(filtered).toHaveLength(2)
      expect(filtered.every((s) => s.type === 'skill')).toBe(true)
    })

    it('without typeFilter returns all pending', () => {
      const s1 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440001',
        type: 'skill',
        title: 'Skill suggestion',
      })
      const s2 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440002',
        type: 'prompt',
        title: 'Prompt suggestion',
      })
      store.save(s1)
      store.save(s2)

      const all = workflow.listPending()
      expect(all).toHaveLength(2)
    })
  })

  describe('previewPlan', () => {
    it('returns implementation plan without executing', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      const plan = workflow.previewPlan(suggestion.id)

      expect(plan).not.toBeNull()
      expect(plan!.suggestionId).toBe(suggestion.id)
      expect(plan!.steps.length).toBeGreaterThan(0)
      // Suggestion status should still be pending
      const current = store.get(suggestion.id)
      expect(current!.status).toBe('pending')
    })

    it('returns null for unknown ID', () => {
      const plan = workflow.previewPlan('nonexistent')
      expect(plan).toBeNull()
    })
  })
})

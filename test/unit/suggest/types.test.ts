import { describe, it, expect } from 'vitest'
import { SuggestionType, SuggestionStatus, SuggestionSchema } from '../../../src/suggest/types.js'

describe('SuggestionType', () => {
  it('contains all expected suggestion types', () => {
    expect(SuggestionType.Skill).toBe('skill')
    expect(SuggestionType.Agent).toBe('agent')
    expect(SuggestionType.Mcp).toBe('mcp')
    expect(SuggestionType.Automation).toBe('automation')
    expect(SuggestionType.Workflow).toBe('workflow')
  })

  it('has exactly 14 types', () => {
    expect(Object.keys(SuggestionType)).toHaveLength(14)
  })

  it('contains all new Phase 12A types', () => {
    expect(SuggestionType.Prompt).toBe('prompt')
    expect(SuggestionType.Extension).toBe('extension')
    expect(SuggestionType.Lsp).toBe('lsp')
    expect(SuggestionType.GithubAction).toBe('github-action')
    expect(SuggestionType.AgenticWorkflow).toBe('agentic-workflow')
    expect(SuggestionType.Instruction).toBe('instruction')
  })

  it('contains tag-proposal (Phase 13.12.12)', () => {
    expect(SuggestionType.TagProposal).toBe('tag-proposal')
  })

  it('contains arm-promotion — the reward learner\u2019s reviewable verdict', () => {
    expect(SuggestionType.ArmPromotion).toBe('arm-promotion')
  })
})

describe('SuggestionStatus', () => {
  it('contains all expected statuses', () => {
    expect(SuggestionStatus.Pending).toBe('pending')
    expect(SuggestionStatus.Approved).toBe('approved')
    expect(SuggestionStatus.Rejected).toBe('rejected')
    expect(SuggestionStatus.Implemented).toBe('implemented')
    expect(SuggestionStatus.NeedsHuman).toBe('needs-human')
    expect(SuggestionStatus.BlockedAutonomy).toBe('blocked-autonomy')
    expect(SuggestionStatus.Failed).toBe('failed')
  })

  it('has exactly 8 statuses', () => {
    expect(Object.keys(SuggestionStatus)).toHaveLength(8)
  })

  it('contains in-progress (Phase 13.12.20)', () => {
    expect(SuggestionStatus.InProgress).toBe('in-progress')
  })
})

describe('SuggestionSchema', () => {
  const validSuggestion = {
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
  }

  it('parses a valid suggestion', () => {
    const result = SuggestionSchema.parse(validSuggestion)
    expect(result.id).toBe(validSuggestion.id)
    expect(result.type).toBe('skill')
    expect(result.title).toBe('Create git-commit helper skill')
    expect(result.confidence).toBe(0.85)
    expect(result.evidence).toHaveLength(1)
    expect(result.tags).toEqual(['git', 'automation'])
  })

  it('rejects missing required fields', () => {
    expect(() => SuggestionSchema.parse({})).toThrow()
    expect(() => SuggestionSchema.parse({ id: '550e8400-e29b-41d4-a716-446655440000' })).toThrow()
  })

  it('applies defaults for status and tags', () => {
    const minimal = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      type: 'skill',
      title: 'Test suggestion',
      description: 'A test',
      confidence: 0.5,
      evidence: [],
      createdAt: '2025-01-15T10:00:00Z',
      updatedAt: '2025-01-15T10:00:00Z',
    }
    const result = SuggestionSchema.parse(minimal)
    expect(result.status).toBe('pending')
    expect(result.tags).toEqual([])
  })

  it('rejects non-uuid id', () => {
    expect(() => SuggestionSchema.parse({ ...validSuggestion, id: 'not-a-uuid' })).toThrow()
  })

  it('rejects empty title', () => {
    expect(() => SuggestionSchema.parse({ ...validSuggestion, title: '' })).toThrow()
  })

  it('rejects confidence out of range', () => {
    expect(() => SuggestionSchema.parse({ ...validSuggestion, confidence: -0.1 })).toThrow()
    expect(() => SuggestionSchema.parse({ ...validSuggestion, confidence: 1.1 })).toThrow()
  })

  it('validates evidence weight defaults', () => {
    const withDefaultWeight = {
      ...validSuggestion,
      evidence: [
        {
          source: 'test',
          detail: 'test detail',
          observedAt: '2025-01-15T10:00:00Z',
        },
      ],
    }
    const result = SuggestionSchema.parse(withDefaultWeight)
    expect(result.evidence[0]!.weight).toBe(0.5)
  })

  it('accepts optional review fields', () => {
    const withReview = {
      ...validSuggestion,
      reviewedAt: '2025-01-16T10:00:00Z',
      reviewReason: 'Looks good',
      implementationPlan: 'Step 1: do the thing',
    }
    const result = SuggestionSchema.parse(withReview)
    expect(result.reviewedAt).toBe('2025-01-16T10:00:00Z')
    expect(result.reviewReason).toBe('Looks good')
    expect(result.implementationPlan).toBe('Step 1: do the thing')
  })

  it('rejects invalid type values', () => {
    expect(() => SuggestionSchema.parse({ ...validSuggestion, type: 'invalid-type' })).toThrow()
  })

  it('rejects invalid status values', () => {
    expect(() => SuggestionSchema.parse({ ...validSuggestion, status: 'invalid-status' })).toThrow()
  })

  it('accepts all valid SuggestionType values', () => {
    for (const type of Object.values(SuggestionType)) {
      const result = SuggestionSchema.parse({ ...validSuggestion, type })
      expect(result.type).toBe(type)
    }
  })

  it('accepts all valid SuggestionStatus values', () => {
    for (const status of Object.values(SuggestionStatus)) {
      const result = SuggestionSchema.parse({ ...validSuggestion, status })
      expect(result.status).toBe(status)
    }
  })

  it('rejects invalid datetime formats', () => {
    expect(() => SuggestionSchema.parse({ ...validSuggestion, createdAt: 'not-a-date' })).toThrow()
    expect(() => SuggestionSchema.parse({ ...validSuggestion, updatedAt: 'not-a-date' })).toThrow()
  })

  it('validates evidence array entries', () => {
    expect(() =>
      SuggestionSchema.parse({
        ...validSuggestion,
        evidence: [{ source: 'test' }],
      }),
    ).toThrow()
  })

  // ── Phase 13.2: actionable shape ─────────────────────────────────

  it('applies default actionable=true when not provided', () => {
    const result = SuggestionSchema.parse(validSuggestion)
    expect(result.actionable).toBe(true)
  })

  it('applies default estimatedComplexity="solo" when not provided', () => {
    const result = SuggestionSchema.parse(validSuggestion)
    expect(result.estimatedComplexity).toBe('solo')
  })

  it('accepts explicit actionable=false', () => {
    const result = SuggestionSchema.parse({ ...validSuggestion, actionable: false })
    expect(result.actionable).toBe(false)
  })

  it('accepts all estimatedComplexity values', () => {
    for (const c of ['solo', 'team', 'complex'] as const) {
      const result = SuggestionSchema.parse({ ...validSuggestion, estimatedComplexity: c })
      expect(result.estimatedComplexity).toBe(c)
    }
  })

  it('rejects invalid estimatedComplexity', () => {
    expect(() =>
      SuggestionSchema.parse({ ...validSuggestion, estimatedComplexity: 'huge' }),
    ).toThrow()
  })

  it('accepts optional suggestedRoles array', () => {
    const result = SuggestionSchema.parse({
      ...validSuggestion,
      suggestedRoles: ['dev', 'qa'],
    })
    expect(result.suggestedRoles).toEqual(['dev', 'qa'])
  })

  it('suggestedRoles is optional', () => {
    const result = SuggestionSchema.parse(validSuggestion)
    expect(result.suggestedRoles).toBeUndefined()
  })

  // ── Phase 13.12.2: blockedMetadata ───────────────────────────────

  it('accepts blockedMetadata with requiredLevel + blockedAt', () => {
    const result = SuggestionSchema.parse({
      ...validSuggestion,
      status: 'blocked-autonomy',
      blockedMetadata: {
        requiredLevel: 3,
        blockedAt: '2025-01-20T12:00:00Z',
      },
    })
    expect(result.status).toBe('blocked-autonomy')
    expect(result.blockedMetadata?.requiredLevel).toBe(3)
    expect(result.blockedMetadata?.blockedAt).toBe('2025-01-20T12:00:00Z')
  })

  it('blockedMetadata is optional', () => {
    const result = SuggestionSchema.parse(validSuggestion)
    expect(result.blockedMetadata).toBeUndefined()
  })

  it('rejects blockedMetadata with requiredLevel out of range', () => {
    expect(() =>
      SuggestionSchema.parse({
        ...validSuggestion,
        blockedMetadata: { requiredLevel: 99, blockedAt: '2025-01-20T12:00:00Z' },
      }),
    ).toThrow()
  })
})

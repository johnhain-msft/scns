import { describe, it, expect } from 'vitest'
import { promoteSuggestions } from '../../../src/brain/suggestion-promoter.js'
import { DecisionPriority, type PendingTask } from '../../../src/brain/state-types.js'
import { createDecisionTree } from '../../../src/brain/decision-tree.js'
import { BrainAction } from '../../../src/brain/state-types.js'
import type { Suggestion } from '../../../src/suggest/types.js'

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  const now = new Date().toISOString()
  return {
    id: overrides.id ?? '11111111-1111-1111-1111-111111111111',
    type: 'skill',
    title: 'Create markdown auto-formatter skill',
    description: 'Add a skill that auto-formats markdown on save.',
    status: 'pending',
    confidence: 0.9,
    evidence: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
    actionable: true,
    estimatedComplexity: 'solo',
    ...overrides,
  } as Suggestion
}

describe('promoteSuggestions — policy', () => {
  it('L2 + actionable + confidence>=0.85 → promotes one task', () => {
    const s = makeSuggestion({ confidence: 0.9 })
    const result = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 5,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [s],
    })
    expect(result.promoted).toHaveLength(1)
    expect(result.promoted[0]!.task.sourceSuggestionId).toBe(s.id)
    expect(result.autoApprovedIds).toContain(s.id)
  })

  it('non-actionable is skipped at L2', () => {
    const s = makeSuggestion({ actionable: false, confidence: 0.95 })
    const result = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 5,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [s],
    })
    expect(result.promoted).toHaveLength(0)
  })

  it('confidence 0.80 at L2 → not promoted (below auto-approve threshold)', () => {
    const s = makeSuggestion({ confidence: 0.8 })
    const result = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 5,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [s],
    })
    expect(result.promoted).toHaveLength(0)
    expect(result.autoApprovedIds).toHaveLength(0)
  })

  it('confidence 0.90 at L1 → not promoted (L1 never auto-approves)', () => {
    const s = makeSuggestion({ confidence: 0.9, status: 'pending' })
    const result = promoteSuggestions({
      autonomyLevel: 1,
      maxConcurrentSessions: 5,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [s],
    })
    expect(result.promoted).toHaveLength(0)
    expect(result.autoApprovedIds).toHaveLength(0)
  })

  it('L1 + already human-approved → promotes (no auto-approval needed)', () => {
    const s = makeSuggestion({ confidence: 0.6, status: 'approved' })
    const result = promoteSuggestions({
      autonomyLevel: 1,
      maxConcurrentSessions: 5,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [s],
    })
    expect(result.promoted).toHaveLength(1)
    expect(result.autoApprovedIds).toHaveLength(0)
  })

  it('L0 never promotes, even approved', () => {
    const s = makeSuggestion({ confidence: 0.95, status: 'approved' })
    const result = promoteSuggestions({
      autonomyLevel: 0,
      maxConcurrentSessions: 5,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [s],
    })
    expect(result.promoted).toHaveLength(0)
  })

  it('duplicate of in-flight task (by sourceSuggestionId) is skipped', () => {
    const s = makeSuggestion({ confidence: 0.95 })
    const inflight: PendingTask = {
      id: 'task-existing',
      description: 'existing',
      priority: DecisionPriority.Normal,
      createdAt: new Date().toISOString(),
      sourceSuggestionId: s.id,
    }
    const result = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 5,
      activeSessions: 0,
      inflightTasks: [inflight],
      suggestions: [s],
    })
    expect(result.promoted).toHaveLength(0)
  })

  it('respects maxConcurrentSessions cap (slots = max - active - inflight)', () => {
    const s1 = makeSuggestion({ id: '11111111-1111-1111-1111-111111111111', confidence: 0.95 })
    const s2 = makeSuggestion({ id: '22222222-2222-2222-2222-222222222222', confidence: 0.92 })
    const s3 = makeSuggestion({ id: '33333333-3333-3333-3333-333333333333', confidence: 0.9 })
    const result = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 2,
      activeSessions: 1,
      inflightTasks: [],
      suggestions: [s1, s2, s3],
    })
    // 2 - 1 active - 0 inflight = 1 slot
    expect(result.promoted).toHaveLength(1)
  })

  it('sorts by confidence desc when picking under cap', () => {
    const low = makeSuggestion({ id: '11111111-1111-1111-1111-111111111111', confidence: 0.86 })
    const high = makeSuggestion({ id: '22222222-2222-2222-2222-222222222222', confidence: 0.99 })
    const result = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 1,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [low, high],
    })
    expect(result.promoted).toHaveLength(1)
    expect(result.promoted[0]!.task.sourceSuggestionId).toBe(high.id)
  })

  it('maps estimatedComplexity → strategy (solo/complex; team-with-roles routed to Path A)', () => {
    const solo = makeSuggestion({
      id: '11111111-1111-1111-1111-111111111111',
      confidence: 0.9,
      estimatedComplexity: 'solo',
    })
    const team = makeSuggestion({
      id: '22222222-2222-2222-2222-222222222222',
      confidence: 0.9,
      estimatedComplexity: 'team',
      suggestedRoles: ['implementer', 'reviewer'],
    })
    const complex = makeSuggestion({
      id: '33333333-3333-3333-3333-333333333333',
      confidence: 0.9,
      estimatedComplexity: 'complex',
      suggestedRoles: ['planner', 'implementer', 'reviewer'],
    })
    const result = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 10,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [solo, team, complex],
    })
    // Phase 13.12.20: team-complexity suggestions WITH suggestedRoles are
    // handled by the brain's ApprovedSuggestions action (Path A) and are
    // therefore NOT promoted into the task queue. Only solo + complex land
    // here (complex has no Path A handler).
    expect(result.promoted).toHaveLength(2)
    const byId = new Map(result.promoted.map((p) => [p.task.sourceSuggestionId, p.task]))
    expect(byId.get(solo.id)!.strategy).toBe('solo')
    expect(byId.get(complex.id)!.strategy).toBe('hybrid')
    expect(byId.has(team.id)).toBe(false)
    // Team suggestion shows up in skipped with the explanatory reason.
    expect(
      result.skipped.find(
        (s) => s.id === team.id && s.reason === 'team-handled-by-approved-suggestions',
      ),
    ).toBeDefined()
  })
})

describe('promoteSuggestions — configurable auto-approve threshold', () => {
  it('autoApproveThreshold override (0.80) auto-approves a 0.80 suggestion at L2', () => {
    const s = makeSuggestion({ confidence: 0.8 })
    const result = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 5,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [s],
      autoApproveThreshold: 0.8,
    })
    expect(result.promoted).toHaveLength(1)
    expect(result.autoApprovedIds).toContain(s.id)
  })

  it('autoApproveThreshold override (0.95) blocks a 0.90 suggestion at L2', () => {
    const s = makeSuggestion({ confidence: 0.9 })
    const result = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 5,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [s],
      autoApproveThreshold: 0.95,
    })
    expect(result.promoted).toHaveLength(0)
    expect(result.autoApprovedIds).toHaveLength(0)
    expect(
      result.skipped.find((x) => x.id === s.id && x.reason === 'below-auto-approve-threshold'),
    ).toBeDefined()
  })

  it('defaults to 0.85 when autoApproveThreshold is omitted (0.84 blocked, 0.85 promoted)', () => {
    const low = makeSuggestion({ id: '44444444-4444-4444-4444-444444444444', confidence: 0.84 })
    const at = makeSuggestion({ id: '55555555-5555-5555-5555-555555555555', confidence: 0.85 })
    const lowResult = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 5,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [low],
    })
    const atResult = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 5,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [at],
    })
    expect(lowResult.promoted).toHaveLength(0)
    expect(atResult.promoted).toHaveLength(1)
    expect(atResult.autoApprovedIds).toContain(at.id)
  })
})

describe('promoteSuggestions — decision-tree integration', () => {
  it('promoted task → decision-tree returns SpawnSolo or SpawnTeam at L2', () => {
    // Phase 13.12.20: use complex suggestion (team + roles is Path A and
    // skipped by promoter). Complex still flows through as hybrid.
    const s = makeSuggestion({
      confidence: 0.95,
      estimatedComplexity: 'complex',
      suggestedRoles: ['planner', 'implementer', 'reviewer'],
    })
    const result = promoteSuggestions({
      autonomyLevel: 2,
      maxConcurrentSessions: 5,
      activeSessions: 0,
      inflightTasks: [],
      suggestions: [s],
    })
    expect(result.promoted).toHaveLength(1)

    const tree = createDecisionTree()
    const decision = tree.selectTaskAction(
      {
        autonomyLevel: 2,
        userActive: false,
        yieldToUser: true,
        pendingTasks: [result.promoted[0]!.task],
        activeSessions: 0,
        maxConcurrentSessions: 5,
        contextUsagePercent: 0,
        contextRotationThreshold: 85,
        recentObservationCount: 10,
        lastConsolidationAge: 1,
        consolidationThreshold: 24,
        approvedSuggestionCount: 0,
        pendingQualityChecks: 0,
        patterns: null,
      },
      result.promoted[0]!.task,
    )
    expect([BrainAction.SpawnTeam, BrainAction.SpawnSolo, BrainAction.HandleSolo]).toContain(
      decision.action,
    )
  })
})

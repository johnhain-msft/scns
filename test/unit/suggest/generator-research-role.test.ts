import { describe, it, expect } from 'vitest'
import { createSuggestionGenerator } from '../../../src/suggest/generator.js'
import { createConfidenceScorer } from '../../../src/suggest/confidence.js'
import { createEvidenceGatherer } from '../../../src/suggest/evidence.js'
import type { Suggestion, SuggestionType } from '../../../src/suggest/types.js'
import type { ProjectFocusPattern } from '../../../src/observe/pattern-detector.js'

// Minimal in-memory store (mirrors test/unit/suggest/generator.test.ts).
function createMockStore() {
  const suggestions = new Map<string, Suggestion>()
  return {
    save: (s: Suggestion) => void suggestions.set(s.id, s),
    get: (id: string) => suggestions.get(id) ?? null,
    list: (status?: string) => {
      const all = [...suggestions.values()]
      return status ? all.filter((s) => s.status === status) : all
    },
    updateStatus: (_id: string, _s: string) => null,
    findSimilar: (_t: string, _ty: SuggestionType) => null,
    getRejectedTitles: () => [] as string[],
    remove: (id: string) => suggestions.delete(id),
  }
}

/** projectFocus whose top repo name lands verbatim in the automation title. */
function focusWithRepo(repo: string): ProjectFocusPattern {
  return {
    repoCounts: new Map([[repo, 30]]),
    topRepos: [repo],
    fileTypeCounts: new Map(),
    recentFocus: null,
    repoActivityCounts: new Map([[repo, 30]]),
  } as ProjectFocusPattern
}

function makeGenerator(researchRoleEmission?: boolean) {
  return createSuggestionGenerator(
    {
      scorer: createConfidenceScorer(),
      evidenceGatherer: createEvidenceGatherer(),
      store: createMockStore(),
    },
    {
      minimumConfidence: 0.3,
      ...(researchRoleEmission !== undefined ? { researchRoleEmission } : {}),
    },
  )
}

const INVESTIGATION_REPO = 'investigate-broker-stall'
const NORMAL_REPO = 'payments-service'

describe('generator — suggestion→researcher role emission (brain-auto surface)', () => {
  it('DEFAULT (ENABLED): investigation-themed suggestion emits scns-researcher + team shape', () => {
    // No researchRoleEmission option ⇒ the default (ON) applies. Dev-default-ON:
    // the brain-auto researcher surface ships enabled, no env gate.
    const gen = makeGenerator()
    const suggestions = gen.generateAutomationSuggestions(focusWithRepo(INVESTIGATION_REPO), 7)
    const s = suggestions.find((x) => x.title.includes(INVESTIGATION_REPO))
    expect(s).toBeDefined()
    // Load-bearing: canonical broker role + 'team' so the brain's
    // suggestion→team path (wantsTeam) actually spawns a researcher.
    expect(s!.suggestedRoles).toEqual(['scns-researcher'])
    expect(s!.estimatedComplexity).toBe('team')
    expect(s!.actionable).toBe(true)
  })

  it('explicit OFF: investigation-themed suggestion carries NO role and keeps its default shape', () => {
    const gen = makeGenerator(false)
    const suggestions = gen.generateAutomationSuggestions(focusWithRepo(INVESTIGATION_REPO), 7)
    const s = suggestions.find((x) => x.title.includes(INVESTIGATION_REPO))
    expect(s).toBeDefined()
    expect(s!.suggestedRoles).toBeUndefined()
    // automation type's default shape is 'solo'.
    expect(s!.estimatedComplexity).toBe('solo')
  })

  it('ENABLED but non-investigation suggestion: still NO role (assignRole is selective, not blanket)', () => {
    const gen = makeGenerator(true)
    const suggestions = gen.generateAutomationSuggestions(focusWithRepo(NORMAL_REPO), 7)
    const s = suggestions.find((x) => x.title.includes(NORMAL_REPO))
    expect(s).toBeDefined()
    expect(s!.suggestedRoles).toBeUndefined()
    expect(s!.estimatedComplexity).toBe('solo')
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutor } from '../../../src/suggest/executor.js'
import type { Suggestion } from '../../../src/suggest/types.js'
import { createLessonStore } from '../../../src/memory/lessons.js'
import { createTaxonomyStore } from '../../../src/memory/taxonomy.js'
import { parseSuggestion, serializeSuggestion } from '../../../src/suggest/suggestion-file.js'

function tagProposalSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  const base: Suggestion = {
    id: '11111111-2222-3333-4444-555555555555',
    type: 'tag-proposal',
    title: 'Tag 3 lessons as "caching"',
    description: 'Proposes a new caching tag',
    status: 'approved',
    confidence: 0.7,
    evidence: [],
    tags: ['tag-proposal', 'caching'],
    createdAt: '2026-04-19T00:00:00.000Z',
    updatedAt: '2026-04-19T00:00:00.000Z',
    actionable: true,
    estimatedComplexity: 'solo',
    attemptCount: 0,
    lastError: null,
    lastAttemptAt: null,
    nextRetryAt: null,
    tagProposal: {
      tagName: 'caching',
      scope: 'project',
      project: 'scns',
      candidateLessonIds: ['seed-a', 'seed-b', 'seed-c'],
      rationale: 'Appears in 3 project lessons',
    },
  }
  return { ...base, ...overrides }
}

describe('tag-proposal executor (13.12.12)', () => {
  let dir: string
  let lessonsDir: string
  let taxonomyPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scns-tagexec-'))
    lessonsDir = join(dir, 'lessons')
    taxonomyPath = join(dir, '.taxonomy.yml')
    const store = createLessonStore({ rootDir: lessonsDir })
    for (const id of ['seed-a', 'seed-b', 'seed-c']) {
      store.create({
        id,
        scope: 'project',
        project: 'scns',
        tags: [],
        body: `Seed lesson ${id} about caching and memoization.`,
      })
    }
  })

  it('generatePlan emits one ApplyTagToLessons step', () => {
    const executor = createExecutor({
      autonomyLevel: 3,
      lessonsDir,
      taxonomyPath,
      configBaseDir: dir,
    })
    const plan = executor.generatePlan(tagProposalSuggestion())
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]!.action).toBe('apply-tag-to-lessons')
  })

  it('execute appends tag to each lesson frontmatter idempotently', () => {
    const executor = createExecutor({
      autonomyLevel: 3,
      lessonsDir,
      taxonomyPath,
      configBaseDir: dir,
    })
    const plan = executor.generatePlan(tagProposalSuggestion())
    const result1 = executor.execute(plan, tagProposalSuggestion())
    expect(result1.success).toBe(true)

    const lessonStore = createLessonStore({ rootDir: lessonsDir })
    const all = lessonStore.listAll()
    for (const l of all) {
      expect(l.frontmatter.tags).toContain('caching')
    }

    // Re-run — must not duplicate tag
    const result2 = executor.execute(plan, tagProposalSuggestion())
    expect(result2.success).toBe(true)
    const all2 = lessonStore.listAll()
    for (const l of all2) {
      const occurrences = l.frontmatter.tags.filter((t) => t === 'caching').length
      expect(occurrences).toBe(1)
    }
  })

  it('execute registers tag in taxonomy.yml', () => {
    const executor = createExecutor({
      autonomyLevel: 3,
      lessonsDir,
      taxonomyPath,
      configBaseDir: dir,
    })
    const plan = executor.generatePlan(tagProposalSuggestion())
    executor.execute(plan, tagProposalSuggestion())
    const tx = createTaxonomyStore({ path: taxonomyPath })
    expect(tx.hasTag('caching')).toBe(true)
    const entry = tx.load().tags.find((t) => t.name === 'caching')!
    expect(entry.scope).toBe('project')
    expect(entry.project).toBe('scns')
  })

  it('skips missing lessons gracefully but still applies to those present', () => {
    const executor = createExecutor({
      autonomyLevel: 3,
      lessonsDir,
      taxonomyPath,
      configBaseDir: dir,
    })
    const s = tagProposalSuggestion({
      tagProposal: {
        tagName: 'caching',
        scope: 'project',
        project: 'scns',
        candidateLessonIds: ['seed-a', 'does-not-exist'],
        rationale: '',
      },
    })
    const plan = executor.generatePlan(s)
    const result = executor.execute(plan, s)
    expect(result.success).toBe(true)
    const lessonStore = createLessonStore({ rootDir: lessonsDir })
    const a = lessonStore.listAll().find((l) => l.frontmatter.id === 'seed-a')!
    expect(a.frontmatter.tags).toContain('caching')
  })

  it('suggestion-file round-trip preserves tagProposal payload', () => {
    const s = tagProposalSuggestion()
    const serialized = serializeSuggestion(s)
    const round = parseSuggestion(serialized)
    expect(round.tagProposal).toBeDefined()
    expect(round.tagProposal!.tagName).toBe('caching')
    expect(round.tagProposal!.scope).toBe('project')
    expect(round.tagProposal!.project).toBe('scns')
    expect(round.tagProposal!.candidateLessonIds).toEqual(['seed-a', 'seed-b', 'seed-c'])
  })
})

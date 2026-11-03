import { describe, it, expect, vi } from 'vitest'
import {
  triageProposal,
  buildNeutralOverlapQuestion,
  buildWorkItemQuestion,
  classifyProposal,
  DUPLICATE_REASON_PREFIX,
} from '../../../src/suggest/proposal-triage.js'
import type { ExistingCapability } from '../../../src/suggest/capability-overlap.js'
import { SuggestionType, type Suggestion } from '../../../src/suggest/types.js'

function suggestion(over: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '2b10b2fa-6b14-46b4-bb64-997b544c275d',
    type: SuggestionType.Extension,
    title: 'Create file-management extension',
    description: 'A file-management extension could streamline edit and create operations.',
    status: 'pending',
    confidence: 0.76,
    evidence: [],
    tags: ['extension', 'file-management'],
    createdAt: '2026-06-03T02:46:00.037Z',
    updatedAt: '2026-06-03T02:46:00.037Z',
    actionable: true,
    estimatedComplexity: 'solo',
    ...(over as object),
  } as Suggestion
}

const existing = (kind: string, name: string): ExistingCapability => ({
  kind,
  name,
  path: `/fake/${kind}/${name}`,
})

describe('buildNeutralOverlapQuestion — the framing guard', () => {
  const q = buildNeutralOverlapQuestion(suggestion(), [existing('extension', 'code-search')])

  // NEGATIVE CONTROL on prompt framing. John: "make sure however we create this that we aren't
  // prompting the llm to explain why its unique if it isn't." A question that presupposes novelty
  // manufactures a justification for it, so these phrasings must never appear.
  it.each([
    'why is this unique',
    'why it is unique',
    'explain why',
    'justify',
    'what makes this different',
    'how is this novel',
  ])('never presupposes novelty: %s', (banned) => {
    expect(q.toLowerCase()).not.toContain(banned)
  })

  it('presents the real existing capabilities rather than an abstract question', () => {
    expect(q).toContain('code-search')
  })

  it('asks for a decidable answer in a fixed format', () => {
    expect(q).toContain('DUPLICATE')
    expect(q).toContain('NOVEL')
  })

  it('names what the proposal actually is, so the model can judge overlap', () => {
    expect(q).toContain('file-management')
  })
})

describe('triageProposal', () => {
  it('does not spend a model call when the disk scan already proved duplication', async () => {
    const ask = vi.fn()
    const r = await triageProposal(suggestion(), [existing('extension', 'file-management')], ask)
    expect(r.outcome).toBe('duplicate')
    expect(ask).not.toHaveBeenCalled()
  })

  it('emits a machine reason that names the collision', async () => {
    const r = await triageProposal(suggestion(), [existing('extension', 'file-management')], vi.fn())
    expect(r.machineReason).toContain(DUPLICATE_REASON_PREFIX)
    expect(r.machineReason).toContain('file-management')
  })

  // The human: prefix is load-bearing downstream (outcome-writer forwards the same field to the
  // learner), so a machine verdict must stay mechanically separable from one of John's.
  it('never disguises a machine verdict as a human reason', async () => {
    const r = await triageProposal(suggestion(), [existing('extension', 'file-management')], vi.fn())
    expect(r.machineReason?.startsWith('human:')).toBe(false)
  })

  it('resolves an inconclusive scan to duplicate when the neutral check finds overlap', async () => {
    const ask = vi.fn().mockResolvedValue('DUPLICATE: the host tool already edits and creates files')
    const r = await triageProposal(suggestion(), [existing('extension', 'code-search')], ask)
    expect(r.outcome).toBe('duplicate')
    expect(r.machineReason).toContain('already edits and creates files')
  })

  it('resolves an inconclusive scan to novel when the neutral check finds no overlap', async () => {
    const ask = vi.fn().mockResolvedValue('NOVEL')
    const r = await triageProposal(suggestion(), [existing('extension', 'code-search')], ask)
    expect(r.outcome).toBe('novel')
  })

  // Failing open to "novel" would generate uniqueness prose we never established — the exact thing
  // John forbade. Failing closed to "duplicate" would silently discard good proposals. So: neither.
  it('returns UNVERIFIED when the neutral check fails, never novel and never duplicate', async () => {
    const ask = vi.fn().mockRejectedValue(new Error('acp timeout'))
    const r = await triageProposal(suggestion(), [existing('extension', 'code-search')], ask)
    expect(r.outcome).toBe('unverified')
  })

  it('returns UNVERIFIED on an unparseable answer', async () => {
    const ask = vi.fn().mockResolvedValue('I think maybe it could possibly be useful?')
    const r = await triageProposal(suggestion(), [existing('extension', 'code-search')], ask)
    expect(r.outcome).toBe('unverified')
  })

  it('treats a missing neutral checker as unverified rather than assuming novelty', async () => {
    const r = await triageProposal(suggestion(), [existing('extension', 'code-search')])
    expect(r.outcome).toBe('unverified')
  })

  it('only a duplicate carries a machine reason', async () => {
    const ask = vi.fn().mockResolvedValue('NOVEL')
    const r = await triageProposal(suggestion(), [], ask)
    expect(r.machineReason).toBeUndefined()
  })
})

describe('classifyProposal — an artifact and a work item are not the same question', () => {
  it('treats a proposed new capability artifact as an artifact', () => {
    for (const t of [
      SuggestionType.Skill,
      SuggestionType.Extension,
      SuggestionType.Mcp,
      SuggestionType.Agent,
      SuggestionType.GithubAction,
    ]) {
      expect(classifyProposal(suggestion({ type: t, title: 'Create X helper skill' }))).toBe('artifact')
    }
  })

  // The three real proposals the first rehearsal wrongly killed with "you can already edit files".
  it('treats a concrete change to this codebase as a work item', () => {
    for (const title of [
      'Emit a structured event when a per-team worktree is reclaimed',
      'Document the external health-watchdog env knobs and kill-switch',
      'Strengthen scns-dev prompt: require a final `git add -A` before exit',
    ]) {
      expect(
        classifyProposal(suggestion({ type: SuggestionType.AgenticWorkflow, title })),
      ).toBe('work-item')
    }
  })

  // NEGATIVE CONTROL: same type, but this one really is proposing a new artifact.
  it('still calls a "create a workflow" proposal an artifact', () => {
    expect(
      classifyProposal(suggestion({ type: SuggestionType.AgenticWorkflow, title: 'Create workflow for lethe' })),
    ).toBe('artifact')
  })
})

describe('buildWorkItemQuestion — asks whether it is DONE, not whether a tool exists', () => {
  const s = suggestion({
    type: SuggestionType.AgenticWorkflow,
    title: 'Emit a structured event when a per-team worktree is reclaimed',
  })

  it('never asks the capability question that caused the category error', () => {
    const q = buildWorkItemQuestion(s).toLowerCase()
    expect(q).not.toContain('duplicate capability')
    expect(q).not.toContain('already exists')
    expect(q).toContain('already been made')
  })

  it('never asks the model to argue for uniqueness (NEGATIVE CONTROL)', () => {
    const q = buildWorkItemQuestion(s).toLowerCase()
    for (const banned of ['why is this unique', 'explain why', 'justify']) {
      expect(q).not.toContain(banned)
    }
  })

  it('offers UNKNOWN so a model with no repo access can say so', () => {
    expect(buildWorkItemQuestion(s)).toContain('UNKNOWN')
  })
})

describe('triageProposal on a work item', () => {
  const workItem = suggestion({
    type: SuggestionType.AgenticWorkflow,
    title: 'Emit a structured event when a per-team worktree is reclaimed',
  })

  it('survives when the model cannot tell whether it is done', async () => {
    const r = await triageProposal(workItem, [], async () => 'UNKNOWN')
    expect(r.outcome).toBe('unverified')
  })

  it('survives on NOT-DONE', async () => {
    const r = await triageProposal(workItem, [], async () => 'NOT-DONE')
    expect(r.outcome).toBe('novel')
  })

  it('is rejected as ALREADY DONE, not as duplicate capability', async () => {
    const r = await triageProposal(workItem, [], async () => 'DONE: the event is already emitted')
    expect(r.outcome).toBe('duplicate')
    expect(r.machineReason).toContain('already-done:')
    expect(r.machineReason).not.toContain('duplicate-capability:')
  })

  // The exact regression: a work item must never be killed by the capability answer.
  it('ignores a capability-style DUPLICATE answer for a work item', async () => {
    const r = await triageProposal(workItem, [], async () => 'DUPLICATE: you can already edit files')
    expect(r.outcome).not.toBe('duplicate')
  })
})

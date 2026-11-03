import { describe, it, expect } from 'vitest'
import {
  buildProposalSpec,
  renderProposalSpec,
  DEFAULT_ARTIFACT_LOCATIONS,
  capabilityScanSpecs,
} from '../../../src/suggest/proposal-spec.js'
import type { TriageResult } from '../../../src/suggest/proposal-triage.js'
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

const novel: TriageResult = { outcome: 'novel', duplicates: [], basis: 'neutral-check' }
const unverified: TriageResult = { outcome: 'unverified', duplicates: [], basis: 'none' }
const roots = { home: '/home/j', config: '/home/j/.copilot', scns: '/home/j/.scns', repo: '/repo' }

describe('capabilityScanSpecs', () => {
  it('derives scan directories from the same map the spec text uses', () => {
    const specs = capabilityScanSpecs(roots)
    const ext = specs.find((s) => s.kind === SuggestionType.Extension)
    expect(ext?.dir).toBe(DEFAULT_ARTIFACT_LOCATIONS[SuggestionType.Extension]!.dir(roots))
  })

  it('covers every type that has a declared artifact home', () => {
    expect(capabilityScanSpecs(roots).length).toBe(Object.keys(DEFAULT_ARTIFACT_LOCATIONS).length)
  })
})

describe('buildProposalSpec', () => {
  it('states what approval writes and where, from the shared location map', () => {
    const spec = buildProposalSpec(suggestion(), novel, roots)
    expect(spec.whatApprovalDoes).toContain(
      DEFAULT_ARTIFACT_LOCATIONS[SuggestionType.Extension]!.dir(roots),
    )
  })

  it('names who does the work from estimatedComplexity', () => {
    expect(buildProposalSpec(suggestion(), novel, roots).whoDoesTheWork).toMatch(/single agent/i)
    const team = suggestion({ estimatedComplexity: 'team' })
    expect(buildProposalSpec(team, novel, roots).whoDoesTheWork).toMatch(/team/i)
  })

  it('says plainly what happens on a no', () => {
    expect(buildProposalSpec(suggestion(), novel, roots).ifYouSayNo).toBeTruthy()
  })

  // The honesty requirement. An unverified proposal must not be dressed up as established-novel.
  it('marks novelty as UNVERIFIED when triage could not establish it', () => {
    const spec = buildProposalSpec(suggestion(), unverified, roots)
    expect(spec.noveltyStatus).toBe('unverified')
    expect(spec.noveltyNote.toLowerCase()).toContain('not been verified')
  })

  it('marks novelty as novel only when triage established it', () => {
    expect(buildProposalSpec(suggestion(), novel, roots).noveltyStatus).toBe('novel')
  })

  // A duplicate is auto-rejected upstream and must never reach a human-facing spec at all.
  it('refuses to build a spec for a duplicate', () => {
    const dupe: TriageResult = {
      outcome: 'duplicate',
      duplicates: [],
      basis: 'disk-scan',
      machineReason: 'duplicate-capability: x',
    }
    expect(() => buildProposalSpec(suggestion(), dupe, roots)).toThrow(/duplicate/i)
  })

  it('carries model elaboration when supplied', () => {
    const spec = buildProposalSpec(suggestion(), novel, roots, 'It would add scaffolding templates.')
    expect(spec.elaboration).toContain('scaffolding templates')
  })

  it('is complete without elaboration — the skeleton is the guarantee', () => {
    const spec = buildProposalSpec(suggestion(), novel, roots)
    expect(spec.elaboration).toBeUndefined()
    expect(spec.whatItIs).toBeTruthy()
    expect(spec.whatApprovalDoes).toBeTruthy()
  })

  it('falls back to a generic home for a type with no declared location', () => {
    const s = suggestion({ type: SuggestionType.ArmPromotion, title: 'Promote arm magma' })
    expect(() => buildProposalSpec(s, novel, roots)).not.toThrow()
  })
})

describe('renderProposalSpec', () => {
  it('renders the questions a reviewer actually needs answered', () => {
    const out = renderProposalSpec(buildProposalSpec(suggestion(), novel, roots))
    expect(out).toContain('What this is')
    expect(out).toContain('If you approve')
    expect(out).toContain('If you say no')
  })

  it('surfaces an unverified novelty warning in the rendered text', () => {
    const out = renderProposalSpec(buildProposalSpec(suggestion(), unverified, roots))
    expect(out.toLowerCase()).toContain('not been verified')
  })

  it('includes the elaboration when present', () => {
    const out = renderProposalSpec(
      buildProposalSpec(suggestion(), novel, roots, 'Adds scaffolding templates.'),
    )
    expect(out).toContain('Adds scaffolding templates.')
  })
})

describe('the spec must not pad — honesty about what is unknown', () => {
  it('does not restate the description, which is already shown above it', () => {
    const spec = buildProposalSpec(suggestion(), novel, roots)
    expect(spec.whatItIs).not.toContain(suggestion().description)
  })

  // John's actual question was "what *is* a file-management extension?" — when nobody has worked
  // that out, the packet must SAY SO rather than recycling the pattern that prompted it.
  it('says plainly when the behaviour has not been worked out', () => {
    const out = renderProposalSpec(buildProposalSpec(suggestion(), novel, roots))
    expect(out).toContain('What it would do')
    expect(out.toLowerCase()).toContain('not been worked out')
  })

  it('drops the caveat once real elaboration exists (NEGATIVE CONTROL)', () => {
    const out = renderProposalSpec(
      buildProposalSpec(suggestion(), novel, roots, 'It would scaffold new files from templates.'),
    )
    expect(out).toContain('It would scaffold new files from templates.')
    expect(out.toLowerCase()).not.toContain('not been worked out')
  })
})

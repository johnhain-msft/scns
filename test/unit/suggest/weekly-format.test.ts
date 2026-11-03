import { describe, it, expect } from 'vitest'
import {
  formatWeeklyHeader,
  formatReviewItem,
  formatReasonMenu,
  formatWeeklyClosing,
} from '../../../src/suggest/weekly-format.js'
import { selectWeeklyPacket } from '../../../src/suggest/weekly-review.js'
import { SuggestionType, type Suggestion } from '../../../src/suggest/types.js'
import type { WeeklySession } from '../../../src/suggest/weekly-session.js'
import type { EngagementAssessment } from '../../../src/suggest/rubber-stamp.js'

const engaged: EngagementAssessment = {
  n: 8,
  sufficientData: true,
  approvalRate: 0.5,
  reasonEntropy: 0.6,
  meanReasonLength: 60,
  disagreedRecently: true,
  rubberStamping: false,
  readyToEscalate: true,
  flags: [],
}

const stamping: EngagementAssessment = {
  ...engaged,
  approvalRate: 1,
  reasonEntropy: 0,
  rubberStamping: true,
  disagreedRecently: false,
  readyToEscalate: false,
  flags: ['approval rate 100% with the same reason repeated', 'no disagreement in the last 8 reviews'],
}

function session(o: Partial<WeeklySession> = {}): WeeklySession {
  return {
    packet: {
      items: [],
      selectedPending: 0,
      selectedBackfill: 0,
      totalPending: 0,
      nonActionablePending: 0,
      totalUnexplained: 0,
      budget: 5,
    },
    engagement: engaged,
    hasWork: false,
    ...o,
  } as WeeklySession
}

describe('formatWeeklyHeader', () => {
  it('says plainly when there is nothing to review', () => {
    const out = formatWeeklyHeader(session())
    expect(out).toMatch(/nothing/i)
    expect(out).not.toMatch(/\d+ proposal/i)
  })

  it('states how many items and why it is asking', () => {
    const s = session({
      packet: {
        items: [{ id: 'i1' } as never],
        selectedPending: 1,
        selectedBackfill: 0,
        totalPending: 7,
        nonActionablePending: 0,
        totalUnexplained: 3,
        budget: 5,
      } as never,
      hasWork: true,
    })
    const out = formatWeeklyHeader(s)
    expect(out).toContain('7')
    expect(out).toMatch(/1 /)
  })

  it('surfaces the rubber-stamp warning to the human rather than hiding it', () => {
    const out = formatWeeklyHeader(session({ engagement: stamping, hasWork: true }))
    expect(out).toMatch(/same reason repeated/)
    expect(out).toMatch(/no disagreement/)
  })

  it('does not nag when engagement looks genuine (NEGATIVE CONTROL)', () => {
    const out = formatWeeklyHeader(session({ engagement: engaged, hasWork: true }))
    expect(out).not.toMatch(/rubber|disagree/i)
  })
})

describe('formatReviewItem', () => {
  const s: Suggestion = {
    id: '11111111-1111-4111-8111-111111111111',
    type: SuggestionType.ArmPromotion,
    title: "Promote retrieval arm 'magma' over 'hybrid'",
    description: 'the learner thinks magma is better',
    confidence: 0.87,
    status: 'pending',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    evidence: [
      {
        source: 'reward-learner:support',
        detail: '12 settled rows on magma',
        observedAt: '2026-07-01T00:00:00.000Z',
        weight: 0.8,
      },
      {
        source: 'reward-learner:support',
        detail: '9 on hybrid',
        observedAt: '2026-07-01T00:00:00.000Z',
        weight: 0.8,
      },
    ],
    tags: [],
    actionable: true,
    estimatedComplexity: 'solo',
  } as unknown as Suggestion

  it('shows what SCNS is proposing AND why it picked this one', () => {
    const out = formatReviewItem(s, 1, 3, 'high uncertainty (confidence 0.87)')
    expect(out).toContain('1 of 3')
    expect(out).toContain(s.title)
    expect(out).toContain('high uncertainty')
    expect(out).toContain('0.87')
  })

  it('shows the evidence, because a verdict without it is a coin flip', () => {
    const out = formatReviewItem(s, 1, 1, 'why')
    expect(out).toContain('12 settled rows on magma')
    expect(out).toContain('9 on hybrid')
  })

  it('shows the full id so the human can act on it outside the session', () => {
    expect(formatReviewItem(s, 1, 1, 'why')).toContain(s.id)
  })
})

describe('formatReasonMenu', () => {
  it('offers the reject taxonomy with descriptions when rejecting', () => {
    const out = formatReasonMenu('reject')
    expect(out).toContain('premature')
    expect(out).toContain('already-exists')
    expect(out).not.toContain('cheap-win')
  })

  it('offers the approve taxonomy when approving', () => {
    const out = formatReasonMenu('approve')
    expect(out).toContain('unblocks')
    expect(out).not.toContain('already-exists')
  })
})

describe('formatWeeklyClosing', () => {
  it('reports what was recorded and what was skipped', () => {
    const out = formatWeeklyClosing({ recorded: 3, skipped: 1, refused: 1 })
    expect(out).toContain('3')
    expect(out).toMatch(/skip/i)
    expect(out).toMatch(/without a reason|no reason/i)
  })

  it('does not mention refusals when there were none (NEGATIVE CONTROL)', () => {
    const out = formatWeeklyClosing({ recorded: 2, skipped: 0, refused: 0 })
    expect(out).not.toMatch(/without a reason|no reason/i)
  })
})

describe('formatReviewItem — the reviewable object', () => {
  const base = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    type: SuggestionType.Extension,
    title: 'Create file-management extension',
    description: 'A file-management extension could streamline edit and create operations.',
    confidence: 0.6,
    status: 'pending',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    evidence: [],
    tags: [],
    actionable: true,
    estimatedComplexity: 'solo',
  } as unknown as Suggestion

  it('shows the implementation spec so the reader knows what approving does', () => {
    const s = {
      ...base,
      implementationPlan: '**What this is** — an extension.\n\n**If you approve** — files land in /x.',
    } as Suggestion
    const out = formatReviewItem(s, 1, 5, 'oldest unreviewed')
    expect(out).toContain('If you approve')
    expect(out).toContain('files land in /x')
  })

  // NEGATIVE CONTROL: no spec must be visibly flagged, never silently look complete.
  it('flags a proposal with no spec instead of presenting it as reviewable', () => {
    const out = formatReviewItem(base, 1, 5, 'oldest unreviewed')
    expect(out.toLowerCase()).toContain('no implementation spec')
  })

  it('offers the explain verdict when a proposal cannot be judged', () => {
    const out = formatReviewItem(base, 1, 5, 'oldest unreviewed')
    expect(out.toLowerCase()).toContain('explain')
  })
})

// The routing section's renderer tests live in `routing-format.test.ts` (Step 2, purpose frame).
describe('formatWeeklyHeader — FR-041 population integrity (T096)', () => {
  let seq = 0
  const sug = (o: Partial<Suggestion> = {}): Suggestion => {
    seq += 1
    return {
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      type: 'skill',
      title: `S${seq}`,
      description: 'd',
      status: 'pending',
      confidence: 0.5,
      evidence: [],
      tags: [],
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      actionable: true,
      ...o,
    } as Suggestion
  }
  const NOW = new Date('2026-07-28T12:00:00.000Z')

  it('does not print a numerator drawn from two pools over a pending-only denominator', () => {
    // The live 2026-08-02 artefact read "5 of 13 pending item(s) selected" — 3 pending + 2 BACKFILL
    // over a pending-only denominator. It passed unnoticed only because 5 <= 13.
    const packet = selectWeeklyPacket({
      pending: Array.from({ length: 13 }, () => sug()),
      terminal: Array.from({ length: 6 }, () => sug({ status: 'rejected', reviewReason: undefined })),
      now: NOW,
      budget: 5,
      backfillSlots: 2,
    })
    const out = formatWeeklyHeader(session({ packet, hasWork: true }))

    expect(out).not.toContain('5 of 13 pending item(s)')
    expect(out).toContain('3 of 13 pending item(s)')
    // The other pool is REPORTED, not dropped — both populations are visible and labelled.
    expect(out).toMatch(/2 of 6 past decision\(s\)/)
  })

  it('discloses pending proposals excluded as non-actionable rather than hiding them', () => {
    const packet = selectWeeklyPacket({
      pending: [
        ...Array.from({ length: 3 }, () => sug()),
        ...Array.from({ length: 4 }, () => sug({ actionable: false })),
      ],
      terminal: [],
      now: NOW,
      budget: 5,
    })
    const out = formatWeeklyHeader(session({ packet, hasWork: true }))
    expect(out).toContain('3 of 3 pending item(s)')
    expect(out).toMatch(/4 .*non-actionable/)
  })

  it('says nothing about non-actionable items when there are none (NEGATIVE CONTROL)', () => {
    const packet = selectWeeklyPacket({
      pending: Array.from({ length: 2 }, () => sug()),
      terminal: [],
      now: NOW,
      budget: 5,
    })
    const out = formatWeeklyHeader(session({ packet, hasWork: true }))
    expect(out).toContain('2 of 2 pending item(s)')
    expect(out).not.toMatch(/non-actionable/)
  })
})

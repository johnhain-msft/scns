/**
 * The escalated pool is the surface that asks John "the machine gave up on your approved work —
 * retry it or close it". Both the sentence it prints and the order it prints in must be derived
 * from the pool, never asserted about it.
 *
 * Two failure modes are pinned here, because both were live and both mislead in the same
 * direction — they overstate how much of the queue John has actually seen and decided:
 *
 *  - claiming HE approved work that auto-approval approved with no human in the loop, on exactly
 *    the unattended population this phase exists to protect;
 *  - ordering by random UUID and then capping, so items outside the first `budget` are unreachable
 *    no matter how many weeks pass.
 *
 * The shape under test is constructed directly at the seam, never assembled through a helper path
 * that a later fix can quietly change.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
import { selectWeeklyPacket, type WeeklyPacket } from '../../../src/suggest/weekly-review.js'
import { formatWeeklyHeader } from '../../../src/suggest/weekly-format.js'
import { recordWeeklyVerdict, type WeeklySession } from '../../../src/suggest/weekly-session.js'
import type { EngagementAssessment } from '../../../src/suggest/rubber-stamp.js'
import type { Suggestion } from '../../../src/suggest/types.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-p10f-pass4-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ENGAGED: EngagementAssessment = {
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

/**
 * Wrap a real packet in the minimum a header needs.
 *
 * `buildWeeklySession` is deliberately NOT used: it reads a store, so the fixture would depend on
 * the store's escalation path, and §14.4 is the finding about a regression test whose shape came
 * from a path a later fix could change. The formatter's seam is the packet, so the packet is what
 * this constructs.
 */
function sessionOf(packet: WeeklyPacket): WeeklySession {
  return {
    packet,
    engagement: ENGAGED,
    hasWork: packet.items.length > 0,
  }
}

/**
 * A gate-exhausted escalation, built field-by-field rather than by driving the gate.
 *
 * `attemptCount > 0` plus a `qg-fail:*` machine reason is the FR-056b discriminator that separates
 * "the implementation was exhausted" from 13.12.16's "a safety gate refused this".
 */
function escalated(o: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '33333333-0000-4000-8000-000000000001',
    type: 'skill',
    title: 'Add retry to the indexer',
    description: 'd',
    status: 'needs-human',
    confidence: 0.83,
    evidence: [],
    tags: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    actionable: true,
    attemptCount: 5,
    machineReason: 'qg-fail:no-diff',
    ...o,
  } as Suggestion
}

describe('the escalated disclosure must be pinned, not just computed', () => {
  // §14.2 filed "a fix with no test is not a fix" against pass 2. Pass 4 found the same class inside
  // pass 3's own remediation: deleting the entire disclosure block from `formatWeeklyHeader` left
  // all 935 suggest tests green. The cap was pinned; the sentence that makes the cap honest was not.
  const NOW = new Date('2026-07-28T12:00:00.000Z')

  it('prints the escalated numerator over the escalated denominator', () => {
    const terminal = Array.from({ length: 7 }, (_, i) =>
      escalated({ id: `33333333-0000-4000-8000-00000000000${i}` }),
    )
    const packet = selectWeeklyPacket({ pending: [], terminal, now: NOW, budget: 3 })

    const header = formatWeeklyHeader(sessionOf(packet))

    expect(packet.selectedEscalated).toBe(3)
    expect(packet.totalEscalated).toBe(7)
    expect(header).toContain('3 of 7')
    // The denominator must be the escalated queue, never the pending one — that swap IS FR-041.
    expect(header).toContain('could not land')
  })

  it('says nothing about escalations when there are none (negative control)', () => {
    const packet = selectWeeklyPacket({
      pending: [escalated({ status: 'pending', attemptCount: 0, machineReason: undefined })],
      terminal: [],
      now: NOW,
      budget: 3,
    })

    expect(packet.selectedEscalated).toBe(0)
    expect(formatWeeklyHeader(sessionOf(packet))).not.toContain('could not land')
  })
})

describe('never attribute a machine auto-approval to the human', () => {
  // `SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD=0.80` is live on the plist, and auto-approval writes
  // `updateStatus(id, 'approved')` with NO verdict and NO reason (agent-loop.ts:1102). So an
  // auto-approved escalation reaches this surface with `reviewVerdict: undefined`, and the packet
  // told him "you approved this" anyway — a false attributed endorsement, delivered at the moment
  // he decides whether to spend more machine time on it, about the unattended population §10.1
  // named as where the harm lands.
  const NOW = new Date('2026-07-28T12:00:00.000Z')

  it('does not claim human approval for an auto-approved escalation', () => {
    const packet = selectWeeklyPacket({
      pending: [],
      terminal: [escalated()],
      now: NOW,
      budget: 5,
    })

    const why = packet.items[0]?.why ?? ''
    expect(why).not.toContain('you approved')
    expect(why).toContain('auto-approved')
    expect(why).toContain('0.83')
  })

  it('DOES credit John when the approval was genuinely his (positive control)', () => {
    const packet = selectWeeklyPacket({
      pending: [],
      terminal: [
        escalated({
          reviewVerdict: 'approve',
          reviewReason: 'human:cheap-win:worth a go',
        }),
      ],
      now: NOW,
      budget: 5,
    })

    expect(packet.items[0]?.why ?? '').toContain('you approved')
  })

  it('the header does not attribute a mixed pool to John either', () => {
    const packet = selectWeeklyPacket({
      pending: [],
      terminal: [
        escalated({ id: '33333333-0000-4000-8000-00000000000a' }),
        escalated({
          id: '33333333-0000-4000-8000-00000000000b',
          reviewVerdict: 'approve',
          reviewReason: 'human:cheap-win:ok',
        }),
      ],
      now: NOW,
      budget: 5,
    })

    const header = formatWeeklyHeader(sessionOf(packet))
    expect(packet.selectedEscalated).toBe(2)
    // "proposal(s) you approved" is false of half this pool. The honest subject is the build.
    expect(header).not.toContain('you approved')
    expect(header).toContain('could not land')
  })
})

describe('a capped escalated pool must not block its own tail forever', () => {
  // Before the §14.3 cap every escalated item rendered: noisy, but reachable. After it, selection
  // was `.sort(by uuid).slice(0, budget)` — and `explain`/`skip` do not drain the pool (§14.3 pins
  // that). A UUID never changes, so the same `budget` items held the entire window every week and
  // the tail was structurally invisible. That is §10.6's "the escalation had no delivery path"
  // restored for everything outside the head.
  const NOW = new Date('2026-07-28T12:00:00.000Z')

  it('orders by how long the item has waited, not by random UUID', () => {
    // Deliberately adversarial: the OLDEST item carries the HIGHEST uuid, so a uuid sort inverts it.
    const terminal = [
      escalated({ id: '33333333-0000-4000-8000-0000000000zz'.replace('zz', '99'), updatedAt: '2026-01-01T00:00:00.000Z' }),
      escalated({ id: '33333333-0000-4000-8000-000000000001', updatedAt: '2026-07-01T00:00:00.000Z' }),
    ]
    const packet = selectWeeklyPacket({ pending: [], terminal, now: NOW, budget: 1 })

    expect(packet.items).toHaveLength(1)
    expect(packet.items[0]?.id).toBe('33333333-0000-4000-8000-000000000099')
  })

  it('rotates an item that John answered with `explain`, so the tail becomes reachable', () => {
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const ids = Array.from(
      { length: 4 },
      (_, i) => `44444444-0000-4000-8000-00000000000${i}`,
    )
    for (const id of ids) {
      store.save(escalated({ id, status: 'pending', attemptCount: 0, machineReason: undefined }))
      store.updateStatus(id, 'approved', 'human:cheap-win:worth a go', undefined, {
        reviewVerdict: 'approve',
      })
      // Drive it past the ceiling so it is genuinely gate-exhausted, not merely failed once.
      for (let i = 0; i < 6; i += 1) store.recordQualityGateFailure(id, 'qg-fail:no-diff')
    }
    const all = ids.map((id) => store.get(id)).filter((s): s is Suggestion => s !== null)
    expect(all).toHaveLength(4)
    expect(all.every((s) => s.status === 'needs-human')).toBe(true)

    const week1 = selectWeeklyPacket({ pending: [], terminal: all, now: NOW, budget: 2 })
    const shown1 = week1.items.map((i) => i.id)
    expect(shown1).toHaveLength(2)

    // John explains both — a non-decision, so neither drains (that invariant is pinned in §14.3).
    for (const id of shown1) {
      const r = recordWeeklyVerdict(store, id, {
        verdict: 'explain',
        code: 'needs-explanation',
        text: 'what does this even do',
      })
      expect(r.ok).toBe(true)
    }

    const all2 = ids.map((id) => store.get(id)).filter((s): s is Suggestion => s !== null)
    expect(all2.every((s) => s.status === 'needs-human')).toBe(true)

    const week2 = selectWeeklyPacket({ pending: [], terminal: all2, now: NOW, budget: 2 })
    const shown2 = week2.items.map((i) => i.id)

    // The whole point: week 2 must not be week 1 again.
    expect(shown2).not.toEqual(shown1)
    expect(new Set([...shown1, ...shown2]).size).toBe(4)
  })
})

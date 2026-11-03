/**
 * A fix that cannot run is not a fix. These tests pin REACHABILITY at three seams where a correct
 * value was being computed and then dropped before anything could observe it:
 *
 *  - the brain's `updateStatus` adapter, which hardcoded its 5th argument and silently discarded
 *    the escalation tag at the wire;
 *  - the approval-attribution reader, which counted a QUESTION (`explain`/`defer`) as an approval
 *    and rendered "you approved this" to John;
 *  - the mislabel census, which keyed on `machineReason` and so skipped the OLDER on-disk shape
 *    entirely, where the gate's failure string was written into the human's own reason field.
 *
 * Each carries explicit positive and negative controls, because the failure mode here is a test
 * that proves only that the fixture reached the function.
 */

import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { censusQgMislabels } from '../../../src/suggest/qg-mislabel-census.js'
import type { Suggestion } from '../../../src/suggest/types.js'
import { selectWeeklyPacket } from '../../../src/suggest/weekly-review.js'

const SRC = join(process.cwd(), 'src')

function mk(over: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '77777777-0000-4000-8000-000000000001',
    type: 'skill',
    title: 'Add retry to the indexer',
    description: 'd',
    confidence: 0.91,
    status: 'needs-human',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    attemptCount: 5,
    machineReason: 'qg-fail:no-diff',
    escalation: 'gate-exhausted',
    evidence: [],
    tags: [],
    actionable: true,
    ...over,
  } as unknown as Suggestion
}

describe('the brain adapter must not drop the escalation tag at the wire', () => {
  // The brain passes `{ escalation: 'gate-refused' }` as the 5th argument to
  // `deps.suggestionStore.updateStatus`. The ONLY production adapter that wires that dependency
  // (`cli.ts`, inside the `createBrainAgent` call) was a 4-parameter arrow function that hardcoded
  // `{ author: 'machine' }` in the 5th slot. Arrow functions have no `arguments` object, so the
  // tag was unreachable in production while three mock-based tests happily asserted it.
  //
  // `tsc --noEmit` CANNOT catch this: TypeScript allows a lower-arity function to satisfy a
  // higher-arity signature. And the comment three lines above the adapter describes fixing this
  // EXACT class of bug for `reason` and `blockedMetadata` — the argument was added to the callers
  // without extending the adapter again. Hence a source-reading guard, like the other wiring guards.
  const cli = readFileSync(join(SRC, 'cli.ts'), 'utf-8')

  /** The brain's `suggestionStore.updateStatus` adapter body. */
  function adapter(): string {
    const anchor = cli.indexOf('createBrainAgent(')
    expect(anchor).toBeGreaterThan(-1)
    const start = cli.indexOf('updateStatus: (', anchor)
    expect(start).toBeGreaterThan(-1)
    const end = cli.indexOf('recordFailure:', start)
    expect(end).toBeGreaterThan(-1)
    return cli.slice(start, end)
  }

  it('declares an opts parameter rather than hardcoding the 5th argument', () => {
    expect(adapter()).toContain('opts')
  })

  it('forwards the brain-supplied opts, and still forces author: machine', () => {
    const body = adapter()
    // The author must remain machine-forced — a brain write is never a human re-decision — but it
    // must be MERGED with what the brain sent, not substituted for it.
    expect(body).toContain("author: 'machine'")
    expect(body).toMatch(/\.\.\.opts|opts\?\./)
  })

  it('NEGATIVE CONTROL: the adapter is not simply passing opts INSTEAD of author', () => {
    // A "fix" that forwards opts but loses `author: 'machine'` would re-open FR-050c: a machine
    // write would start looking like a human re-decision and could erase John's verdict.
    const body = adapter()
    const authorIdx = body.indexOf("author: 'machine'")
    expect(authorIdx).toBeGreaterThan(-1)
  })
})

describe('a QUESTION is not an approval', () => {
  // `recordWeeklyVerdict`'s non-decision branch (`weekly-session.ts:243`) writes a `human:`-prefixed
  // reason for `explain` and `defer` — e.g. `human:needs-explanation: what IS a file-management
  // extension?` — while leaving the status alone. `wasHumanApproved` sniffed `human:` and called
  // that an approval, so the next packet told John "you approved this" about an item he had only
  // asked a question about.
  //
  // This is §15.2 recurring INSIDE pass 4's own fix for §15.2, and it is not theoretical: the
  // first live review is on record as John answering every proposal with a question.
  const why = (s: Suggestion): string => {
    const packet = selectWeeklyPacket({
      pending: [],
      terminal: [s],
      now: new Date('2026-08-04T00:00:00.000Z'),
    })
    const item = packet.items.find((i) => i.id === s.id)
    expect(item, `no packet item for ${s.id}; packet had ${packet.items.length}`).toBeDefined()
    return item!.why
  }

  it('an EXPLAIN is not rendered as an endorsement', () => {
    const line = why(
      mk({
        reviewVerdict: 'explain' as never,
        reviewReason: 'human:needs-explanation: what IS a file-management extension?',
      }),
    )
    expect(line).not.toContain('you approved this')
  })

  it('a DEFER is not rendered as an endorsement', () => {
    const line = why(
      mk({
        reviewVerdict: 'defer' as never,
        reviewReason: 'human:not-now: revisit after the migration',
      }),
    )
    expect(line).not.toContain('you approved this')
  })

  it('POSITIVE CONTROL: a real human approval still says so', () => {
    const line = why(
      mk({ reviewVerdict: 'approve' as never, reviewReason: 'human:cheap-win: worth a go' }),
    )
    expect(line).toContain('you approved this')
  })

  it('POSITIVE CONTROL: a human reason with NO verdict at all is still an approval', () => {
    // The disjunct exists for a real case — a `human:` reason written through a seam with no
    // verdict field. Narrowing it must not delete that case, only the non-decision verdicts.
    const line = why(mk({ reviewVerdict: undefined, reviewReason: 'human:cheap-win: worth a go' }))
    expect(line).toContain('you approved this')
  })

  it('NEGATIVE CONTROL: an auto-approved item is still disclosed as unreviewed', () => {
    const line = why(mk({ reviewVerdict: undefined, reviewReason: undefined }))
    expect(line).toContain('auto-approved')
    expect(line).not.toContain('you approved this')
  })
})

describe('the census must count the OLDER mislabel shape', () => {
  // Measured on John's live corpus: `~/.scns/suggestions/rejected/` holds NINE files carrying
  //   status: "rejected"      reviewReason: "qg-fail:tests-failed" | "qg-fail:no-diff"
  // with NO `machineReason` field at all. `censusQgMislabels` requires
  // `machineReason.startsWith('qg-fail:')`, so it skips all nine and reports VIOLATIONS: 1.
  //
  // This matters because the census is this phase's own measurement instrument and §9 read its
  // output as vindication ("VIOLATIONS: 1 and that is correct"). The predicate was calibrated to
  // the shape the FIX installs, not the shape the damaged corpus actually has.
  //
  // These nine are NOT provably human approvals — the gate wrote its failure string into
  // `reviewReason`, the HUMAN's field, destroying whatever John may have said. So they must NOT be
  // folded into SC-029's number, whose definition is "human approvals wearing the human-refusal
  // label". They are a distinct, separately-counted category, because their damage is identical:
  // `rejected` is in FAILED_VERDICTS, and `PERMANENT_REJECT` blocks their families in dedup
  // unconditionally, with no time window, forever.
  const dir = mkdtempSync(join(tmpdir(), 'scns-census-'))
  mkdirSync(join(dir, 'rejected'), { recursive: true })

  const write = (name: string, fm: string): void =>
    writeFileSync(join(dir, 'rejected', name), `---\n${fm}\n---\n\n## Description\n\nd\n`, 'utf-8')

  write(
    'aaaaaaaa-0000-4000-8000-000000000001.md',
    'id: "aaaaaaaa-0000-4000-8000-000000000001"\ntype: "automation"\ntitle: "Create py linting automation"\nstatus: "rejected"\nreviewReason: "qg-fail:no-diff"',
  )
  write(
    'bbbbbbbb-0000-4000-8000-000000000002.md',
    'id: "bbbbbbbb-0000-4000-8000-000000000002"\ntype: "skill"\ntitle: "A real refusal"\nstatus: "rejected"\nreviewVerdict: "reject"\nreviewReason: "human:already-exists: we have this"',
  )
  write(
    'cccccccc-0000-4000-8000-000000000003.md',
    'id: "cccccccc-0000-4000-8000-000000000003"\ntype: "skill"\ntitle: "Classic mislabel"\nstatus: "rejected"\nreviewVerdict: "approve"\nreviewReason: "human:cheap-win: go"\nmachineReason: "qg-fail:tests-failed"',
  )

  const census = censusQgMislabels(dir)

  it('counts the reason-overwritten shape instead of silently skipping it', () => {
    expect(census.machineWrittenRefusals).toHaveLength(1)
    expect(census.machineWrittenRefusals[0]?.id).toBe('aaaaaaaa-0000-4000-8000-000000000001')
  })

  it("does NOT inflate SC-029's violations number with it — intent there is unrecoverable", () => {
    expect(census.violations).toHaveLength(1)
    expect(census.violations[0]?.id).toBe('cccccccc-0000-4000-8000-000000000003')
  })

  it("NEGATIVE CONTROL: John's genuine rejection is counted in neither bucket", () => {
    const ids = [...census.violations, ...census.machineWrittenRefusals].map((v) => v.id)
    expect(ids).not.toContain('bbbbbbbb-0000-4000-8000-000000000002')
  })

  it('scans everything it was given (the skip is a classification, not a read failure)', () => {
    expect(census.scanned).toBe(3)
    expect(census.unreadable).toBe(0)
  })
})

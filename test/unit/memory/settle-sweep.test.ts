import { describe, it, expect, vi } from 'vitest'
import {
  openExperienceStore,
  logRetrievalExperience,
  settleHumanOutcome,
  FOLLOWUP_REFUSAL_BACKOFF_BASE_MS,
  type ExperienceStore,
} from '../../../src/memory/experience-store.js'
import type { SessionTranscript, HumanTurn } from '../../../src/memory/session-transcript.js'
import { findUnsettledConversations } from '../../../src/memory/query-chain.js'
import { runSettleSweep } from '../../../src/memory/settle-sweep.js'
import type { FollowupReading } from '../../../src/memory/followup-satisfaction.js'

// ── The cross-conversation SETTLE SWEEP ───────────────────────────────────────────────────────────
// The accept/waste harvest was reachable from EXACTLY ONE place — inside the live briefing hook
// (src/cli.ts), which settles the PRIOR turn only when a NEW briefing arrives in the SAME
// conversation. Measured read-only over the live corpus on 2026-07-31 (rows since 2026-07-27):
//
//   arm/author            S0_rows  S1_conv  S2_unsettled  S3_delivered  S4_in_transcript  S5_has_next
//   magma/machine             676      676           676           656               639            3
//   magma/human               239      237           234           225               222           21
//   multihop-iter/human        50       49            48            38                33            5
//
//   BRIEFINGS PER CONVERSATION: 911 conversations, 902 of them (99.0%) carry exactly ONE briefing.
//
// So 29 fully-labellable pairs (24 magma / 5 multihop-iter) sat permanently unharvested: the second
// briefing that would have triggered their harvest never arrives. This sweep removes that gating and
// nothing else. It introduces NO new gradient, NO new classifier and NO new settle path — it drives
// the existing producers (findChainOutcome / findChainResidue → settleChainOutcome /
// settleFollowupOutcome) across conversations instead of one-at-a-time from the hot path.

const turn = (turnIndex: number, text: string): HumanTurn => ({
  turnIndex,
  text,
  timestampMs: null,
})

/** A transcript keyed by conversation, unlike the single-session fake used by query-chain tests. */
const mkTranscript = (
  bySession: Record<string, readonly HumanTurn[]>,
  mode: 'oracle' | 'fallback' = 'oracle',
): SessionTranscript => ({
  mode,
  reason: '',
  path: '/tmp/fake-session-store.db',
  humanTurns: (sessionId: string) => bySession[sessionId] ?? [],
  close: () => {},
})

const mk = (
  store: ExperienceStore,
  conversationId: string,
  queryText: string,
  latencyMs: number | null = 200,
): number =>
  logRetrievalExperience(store, {
    queryText,
    levers: { traverse: true, synthesize: true },
    retrievedChunkIds: [1, 2],
    conversationId,
    ...(latencyMs !== null ? { latencyMs } : {}),
  })

const outcomeOf = (store: ExperienceStore, id: number): number | null =>
  (
    store.db.prepare(`SELECT human_outcome FROM retrieval_experience WHERE id = ?`).get(id) as {
      human_outcome: number | null
    }
  ).human_outcome

const sourceOf = (store: ExperienceStore, id: number): string | null =>
  (
    store.db.prepare(`SELECT answer_source FROM retrieval_experience WHERE id = ?`).get(id) as {
      answer_source: string | null
    }
  ).answer_source

const REASK: FollowupReading = { cue: 're-asked', pattern: 'repeat-need', confidence: 0.9 }

describe('findUnsettledConversations — the sweep frontier', () => {
  it('returns conversations that still hold an unsettled, non-full row, newest first', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'conv-a', 'how do i restart the broker safely')
    const settled = mk(store, 'conv-b', 'what is the semantic edge tier')
    settleHumanOutcome(store, settled, 1.0)
    mk(store, 'conv-c', 'explain the adaptive traversal policy')

    const convs = findUnsettledConversations(store)
    expect(convs).toEqual(['conv-c', 'conv-a'])
    store.close()
  })

  it('NEGATIVE: a conversation whose rows are all settled is not returned', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'conv-only', 'how do i restart the broker safely')
    settleHumanOutcome(store, id, 0.2)
    expect(findUnsettledConversations(store)).toEqual([])
    store.close()
  })

  it('is bounded by `limit`', () => {
    const store = openExperienceStore(':memory:')
    for (let i = 0; i < 5; i++) mk(store, `conv-${i}`, `question number ${i} about the broker`)
    expect(findUnsettledConversations(store, { limit: 2 })).toHaveLength(2)
    store.close()
  })
})

describe('runSettleSweep — harvests conversations the briefing hook can never revisit', () => {
  it('POSITIVE: settles a SINGLE-briefing conversation (the 99% live case)', async () => {
    const store = openExperienceStore(':memory:')
    const q = 'how do i restart the scns broker safely'
    const id = mk(store, 'conv-1', q)
    // Exactly ONE briefing in this conversation — no second one will ever arrive, so the in-hook
    // sweep can never fire. The human DID answer in the transcript.
    const transcript = mkTranscript({
      'conv-1': [turn(0, q), turn(1, 'how do i restart the scns broker without losing state')],
    })

    const summary = await runSettleSweep({ store, transcript })

    expect(summary.chainSettled).toBe(1)
    expect(summary.settledIds).toEqual([id])
    expect(outcomeOf(store, id)).toBe(0.2) // a reformulation = the briefing did not serve
    expect(sourceOf(store, id)).toMatch(/^query-chain:/)
    store.close()
  })

  it('POSITIVE: sweeps MANY conversations in one run, not just the caller’s own', async () => {
    const store = openExperienceStore(':memory:')
    const qa = 'how do i restart the scns broker safely'
    const qb = 'how do i prune the vault embeddings safely'
    const a = mk(store, 'conv-a', qa)
    const b = mk(store, 'conv-b', qb)
    const transcript = mkTranscript({
      'conv-a': [turn(0, qa), turn(1, 'how do i restart the scns broker without losing state')],
      'conv-b': [turn(0, qb), turn(1, 'how do i prune the vault embeddings without losing state')],
    })

    const summary = await runSettleSweep({ store, transcript })

    expect(summary.chainSettled).toBe(2)
    expect(summary.settledIds.sort()).toEqual([a, b].sort())
    store.close()
  })

  it('routes the ABSTAIN RESIDUE to the follow-up reader and settles on its verdict', async () => {
    const store = openExperienceStore(':memory:')
    const q = 'how do i restart the scns broker safely'
    const id = mk(store, 'conv-1', q)
    // A substantive but non-classifiable follow-up ⇒ the deterministic rules abstain ⇒ residue.
    const transcript = mkTranscript({
      'conv-1': [turn(0, q), turn(1, 'that did not help me at all, the port stays bound')],
    })
    const readFollowup = vi.fn(async () => REASK)

    const summary = await runSettleSweep({ store, transcript, readFollowup })

    expect(readFollowup).toHaveBeenCalledTimes(1)
    expect(summary.followupSettled).toBe(1)
    expect(outcomeOf(store, id)).toBe(0.2)
    expect(sourceOf(store, id)).toMatch(/^followup:repeat-need:turn-1:conf-0\.90$/)
    store.close()
  })

  it('an ABSTAINING reader leaves the row NULL and does not loop forever', async () => {
    const store = openExperienceStore(':memory:')
    const q = 'how do i restart the scns broker safely'
    const id = mk(store, 'conv-1', q)
    const transcript = mkTranscript({
      'conv-1': [turn(0, q), turn(1, 'that did not help me at all, the port stays bound')],
    })
    const readFollowup = vi.fn(async () => null)

    const summary = await runSettleSweep({ store, transcript, readFollowup })

    expect(readFollowup).toHaveBeenCalledTimes(1)
    expect(summary.followupSettled).toBe(0)
    expect(summary.followupAbstained).toBe(1)
    expect(outcomeOf(store, id)).toBeNull()
    store.close()
  })

  it('NEGATIVE CONTROL: never labels without the transcript ORACLE', async () => {
    const store = openExperienceStore(':memory:')
    const q = 'how do i restart the scns broker safely'
    const id = mk(store, 'conv-1', q)
    const transcript = mkTranscript(
      { 'conv-1': [turn(0, q), turn(1, 'how do i restart the scns broker without losing state')] },
      'fallback',
    )
    const readFollowup = vi.fn(async () => REASK)

    const summary = await runSettleSweep({ store, transcript, readFollowup })

    expect(summary.chainSettled).toBe(0)
    expect(summary.followupSettled).toBe(0)
    expect(readFollowup).not.toHaveBeenCalled()
    expect(outcomeOf(store, id)).toBeNull()
    store.close()
  })

  it('NEGATIVE CONTROL: an UNDELIVERED briefing (over the client budget) is never labelled', async () => {
    const store = openExperienceStore(':memory:')
    const q = 'how do i restart the scns broker safely'
    const id = logRetrievalExperience(store, {
      queryText: q,
      levers: { traverse: true, synthesize: true },
      retrievedChunkIds: [1],
      conversationId: 'conv-1',
      latencyMs: 9000,
      clientTimeoutMs: 5000, // the client aborted — the human never saw this briefing
    })
    const transcript = mkTranscript({
      'conv-1': [turn(0, q), turn(1, 'how do i restart the scns broker without losing state')],
    })

    const summary = await runSettleSweep({ store, transcript })

    expect(summary.chainSettled).toBe(0)
    expect(outcomeOf(store, id)).toBeNull()
    store.close()
  })

  it('NEGATIVE CONTROL: first-signal-wins — an already-settled row is never overwritten', async () => {
    const store = openExperienceStore(':memory:')
    const q = 'how do i restart the scns broker safely'
    const id = mk(store, 'conv-1', q)
    settleHumanOutcome(store, id, 1.0) // an oracle-grade ACCEPT already won this row
    const transcript = mkTranscript({
      'conv-1': [turn(0, q), turn(1, 'how do i restart the scns broker without losing state')],
    })

    const summary = await runSettleSweep({ store, transcript })

    expect(summary.chainSettled).toBe(0)
    expect(outcomeOf(store, id)).toBe(1.0)
    store.close()
  })

  it('BOUNDED: `maxReads` caps how many ACP reads one run may spawn', async () => {
    const store = openExperienceStore(':memory:')
    const transcript: Record<string, readonly HumanTurn[]> = {}
    for (let i = 0; i < 4; i++) {
      const q = `how do i configure the retention window for project ${i}`
      mk(store, `conv-${i}`, q)
      transcript[`conv-${i}`] = [
        turn(0, q),
        turn(1, 'that did not help me at all, it is still wrong'),
      ]
    }
    const readFollowup = vi.fn(async () => REASK)

    const summary = await runSettleSweep(
      { store, transcript: mkTranscript(transcript), readFollowup },
      { maxReads: 2 },
    )

    expect(readFollowup).toHaveBeenCalledTimes(2)
    expect(summary.followupSettled).toBe(2)
    store.close()
  })

  it('BOUNDED: `maxConversations` caps the frontier', async () => {
    const store = openExperienceStore(':memory:')
    const transcript: Record<string, readonly HumanTurn[]> = {}
    for (let i = 0; i < 4; i++) {
      const q = `how do i configure the retention window for project ${i}`
      mk(store, `conv-${i}`, q)
      transcript[`conv-${i}`] = [
        turn(0, q),
        turn(1, `how do i set the retention window on project ${i}`),
      ]
    }

    const summary = await runSettleSweep(
      { store, transcript: mkTranscript(transcript) },
      { maxConversations: 2 },
    )

    expect(summary.conversationsScanned).toBe(2)
    store.close()
  })

  it('FAIL-SAFE: a throwing reader never throws out of the sweep', async () => {
    const store = openExperienceStore(':memory:')
    const q = 'how do i restart the scns broker safely'
    const id = mk(store, 'conv-1', q)
    const transcript = mkTranscript({
      'conv-1': [turn(0, q), turn(1, 'that did not help me at all, the port stays bound')],
    })
    const readFollowup = vi.fn(async () => {
      throw new Error('acp worker died')
    })

    const summary = await runSettleSweep({ store, transcript, readFollowup })

    expect(summary.followupSettled).toBe(0)
    expect(outcomeOf(store, id)).toBeNull()
    store.close()
  })

  it('with NO reader wired the sweep is deterministic-only and still settles chain outcomes', async () => {
    const store = openExperienceStore(':memory:')
    const q = 'how do i restart the scns broker safely'
    const id = mk(store, 'conv-1', q)
    const transcript = mkTranscript({
      'conv-1': [turn(0, q), turn(1, 'how do i restart the scns broker without losing state')],
    })

    const summary = await runSettleSweep({ store, transcript })

    expect(summary.chainSettled).toBe(1)
    expect(summary.followupSettled).toBe(0)
    expect(outcomeOf(store, id)).toBe(0.2)
    store.close()
  })
})

// ── DURABLE refusal back-off (issue #17; spec 003 US4, contracts/refusal-backoff.md) ──────────────
// The refusal bookkeeping used to be `const offeredResidue = new Set<number>()`, constructed inside
// a single run — nothing survived the run, and a refused row keeps `human_outcome IS NULL`, so the
// same permanent abstainers re-entered the frontier every hour in the same position and consumed the
// entire ACP read budget. Measured live before this fix: 283 of 319 runs settled ZERO with
// `followupAbstained` pinned at exactly `maxReads` (12). These tests encode the contract's controls
// (FR-007..FR-011, SC-006) at sweep level; the `followup_refusal` table itself is covered in
// `experience-store.test.ts`.

describe('runSettleSweep — a refusal is durable across runs (#17)', () => {
  /** Substantive but non-classifiable ⇒ the deterministic rules abstain ⇒ reader residue. */
  const RESIDUE_FOLLOWUP = 'that did not help me at all, the port stays bound'

  it('FR-007 (T063): a pair the reader refused is NOT offered again on the immediately following run', async () => {
    const store = openExperienceStore(':memory:')
    const q = 'how do i restart the scns broker safely'
    const id = mk(store, 'conv-1', q)
    const transcript = mkTranscript({ 'conv-1': [turn(0, q), turn(1, RESIDUE_FOLLOWUP)] })

    const firstReader = vi.fn(async () => null)
    const first = await runSettleSweep({ store, transcript, readFollowup: firstReader })
    expect(firstReader).toHaveBeenCalledTimes(1)
    expect(first.followupAbstained).toBe(1)

    // The immediately following run — same corpus, same transcript, real clock.
    const secondReader = vi.fn(async () => null)
    const second = await runSettleSweep({ store, transcript, readFollowup: secondReader })

    expect(secondReader).not.toHaveBeenCalled()
    expect(second.followupAbstained).toBe(0)
    expect(second.deferredByBackoff).toBe(1)
    expect(outcomeOf(store, id)).toBeNull() // deferred, never labelled — this is scheduling only
    store.close()
  })

  it('FR-010 (T064): a genuinely NEW eligible pair is still read on the next run', async () => {
    const store = openExperienceStore(':memory:')
    const qOld = 'how do i restart the scns broker safely'
    mk(store, 'conv-old', qOld)
    const abstain = vi.fn(async () => null)
    await runSettleSweep({
      store,
      transcript: mkTranscript({ 'conv-old': [turn(0, qOld), turn(1, RESIDUE_FOLLOWUP)] }),
      readFollowup: abstain,
    })
    expect(abstain).toHaveBeenCalledTimes(1)

    // Between runs a brand-new conversation arrives.
    const qNew = 'how do i prune the vault embeddings safely'
    mk(store, 'conv-new', qNew)
    const reader = vi.fn(async () => REASK)
    const second = await runSettleSweep({
      store,
      transcript: mkTranscript({
        'conv-old': [turn(0, qOld), turn(1, RESIDUE_FOLLOWUP)],
        'conv-new': [turn(0, qNew), turn(1, 'still cannot prune them, the index keeps growing')],
      }),
      readFollowup: reader,
    })

    // The one read went to the unseen pair; the refused one was deferred without cost.
    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader).toHaveBeenCalledWith({
      priorQuery: qNew,
      nextTurn: 'still cannot prune them, the index keeps growing',
    })
    expect(second.followupSettled).toBe(1)
    expect(second.readsOnNewPairs).toBe(1)
    expect(second.readsOnRetriedPairs).toBe(0)
    expect(second.deferredByBackoff).toBe(1)
    store.close()
  })

  it('FR-010 (T071): within a conversation, a never-offered pair is returned BEFORE a previously-refused one — ordering, not just filtering', async () => {
    const store = openExperienceStore(':memory:')
    const q1 = 'how do i configure the vault retention window safely'
    const q2 = 'how do i rotate the broker api credentials safely'
    const r1 = mk(store, 'conv-1', q1)
    mk(store, 'conv-1', q2) // newer row — offered first by the newest-first default
    const turns = [turn(0, q1), turn(1, RESIDUE_FOLLOWUP), turn(2, q2), turn(3, RESIDUE_FOLLOWUP)]
    const abstain = vi.fn(async () => null)
    await runSettleSweep(
      { store, transcript: mkTranscript({ 'conv-1': turns }), readFollowup: abstain },
      { maxReads: 1 },
    )
    expect(abstain).toHaveBeenCalledTimes(1)
    expect(abstain).toHaveBeenCalledWith({ priorQuery: q2, nextTurn: RESIDUE_FOLLOWUP })

    // The conversation gains a turn, so the refused pair RECOVERS (FR-008) and is eligible again.
    // Ordering must STILL put the never-offered pair first — if the fix only filtered deferred
    // pairs, the newest-first default would hand the budget back to the recovered retry.
    const reader = vi.fn(async () => REASK)
    const second = await runSettleSweep(
      {
        store,
        transcript: mkTranscript({
          'conv-1': [...turns, turn(4, 'unrelated new turn about the dashboard styling')],
        }),
        readFollowup: reader,
      },
      { maxReads: 1 },
    )

    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader).toHaveBeenCalledWith({ priorQuery: q1, nextTurn: RESIDUE_FOLLOWUP })
    expect(second.readsOnNewPairs).toBe(1)
    expect(outcomeOf(store, r1)).toBe(0.2)
    store.close()
  })

  it('FR-008 (T066): NEW EVIDENCE recovers a refused pair — the conversation gained turns', async () => {
    const store = openExperienceStore(':memory:')
    const q = 'how do i restart the scns broker safely'
    const id = mk(store, 'conv-1', q)
    const abstain = vi.fn(async () => null)
    await runSettleSweep({
      store,
      transcript: mkTranscript({ 'conv-1': [turn(0, q), turn(1, RESIDUE_FOLLOWUP)] }),
      readFollowup: abstain,
    })
    expect(abstain).toHaveBeenCalledTimes(1)

    // Same pair, but the conversation has moved on since the refusal (turn count 3 > 2).
    const reader = vi.fn(async () => REASK)
    const second = await runSettleSweep({
      store,
      transcript: mkTranscript({
        'conv-1': [
          turn(0, q),
          turn(1, RESIDUE_FOLLOWUP),
          turn(2, 'the broker came back but the dashboard still shows it as offline'),
        ],
      }),
      readFollowup: reader,
    })

    expect(reader).toHaveBeenCalledTimes(1)
    expect(second.readsOnRetriedPairs).toBe(1)
    expect(second.readsOnNewPairs).toBe(0)
    expect(outcomeOf(store, id)).toBe(0.2)
    store.close()
  })

  it('FR-008 (T066): ELAPSED TIME recovers a refused pair, and the window doubles per attempt', async () => {
    const store = openExperienceStore(':memory:')
    const q = 'how do i restart the scns broker safely'
    mk(store, 'conv-1', q)
    const transcript = mkTranscript({ 'conv-1': [turn(0, q), turn(1, RESIDUE_FOLLOWUP)] })
    const readFollowup = vi.fn(async () => null)
    const t0 = Date.now()
    const SLACK = 5 * 60 * 1000 // refusals are stamped with the real clock; absorb test wall-time

    await runSettleSweep({ store, transcript, readFollowup })
    expect(readFollowup).toHaveBeenCalledTimes(1)

    // First window (1 attempt = base) has elapsed: offered again, refused again.
    await runSettleSweep(
      { store, transcript, readFollowup },
      { now: new Date(t0 + FOLLOWUP_REFUSAL_BACKOFF_BASE_MS + SLACK) },
    )
    expect(readFollowup).toHaveBeenCalledTimes(2)

    // Second window doubles (2 attempts = 2×base): one base later it is still deferred…
    const deferred = await runSettleSweep(
      { store, transcript, readFollowup },
      { now: new Date(t0 + 2 * FOLLOWUP_REFUSAL_BACKOFF_BASE_MS + SLACK) },
    )
    expect(readFollowup).toHaveBeenCalledTimes(2)
    expect(deferred.deferredByBackoff).toBe(1)

    // …and eligible again once the doubled window has fully passed.
    await runSettleSweep(
      { store, transcript, readFollowup },
      { now: new Date(t0 + 4 * FOLLOWUP_REFUSAL_BACKOFF_BASE_MS + 2 * SLACK) },
    )
    expect(readFollowup).toHaveBeenCalledTimes(3)
    store.close()
  })

  it('SC-006 (T067): across ten consecutive runs the refusal count is not pinned at maxReads, and the budget goes to never-offered pairs', async () => {
    const store = openExperienceStore(':memory:')
    const maxReads = 2
    const bySession: Record<string, readonly HumanTurn[]> = {}
    const permanent = new Set<string>()
    for (let i = 0; i < maxReads; i++) {
      const q = `how do i configure the retention window for project ${i}`
      permanent.add(q)
      mk(store, `conv-perm-${i}`, q)
      bySession[`conv-perm-${i}`] = [turn(0, q), turn(1, RESIDUE_FOLLOWUP)]
    }
    // The reader permanently refuses the two seed pairs and labels everything else.
    const readFollowup = vi.fn(async (req: { priorQuery: string; nextTurn: string }) =>
      permanent.has(req.priorQuery) ? null : REASK,
    )

    const summaries = []
    for (let run = 1; run <= 10; run++) {
      if (run > 1) {
        // Unseen eligible pairs are AVAILABLE on every subsequent run (the SC-006 precondition).
        for (let s = 0; s < maxReads; s++) {
          const q = `how do i tune the semantic edge threshold for run ${run} slot ${s}`
          mk(store, `conv-fresh-${run}-${s}`, q)
          bySession[`conv-fresh-${run}-${s}`] = [turn(0, q), turn(1, RESIDUE_FOLLOWUP)]
        }
      }
      summaries.push(
        await runSettleSweep(
          { store, transcript: mkTranscript(bySession), readFollowup },
          { maxReads },
        ),
      )
    }

    // Run 1 IS the pre-fix pathology: every read refused, pinned at exactly maxReads.
    expect(summaries[0]?.followupAbstained).toBe(maxReads)
    // From run 2 on, the durable refusals free the whole budget for never-offered pairs.
    const rest = summaries.slice(1)
    expect(rest.every((s) => s.followupAbstained === 0)).toBe(true)
    expect(rest.every((s) => s.followupSettled === maxReads)).toBe(true)
    const majorityOnNew = summaries.filter((s) => s.readsOnNewPairs > s.readsOnRetriedPairs)
    expect(majorityOnNew.length).toBeGreaterThanOrEqual(8)
    store.close()
  })
})

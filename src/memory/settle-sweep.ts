/**
 * The cross-conversation SETTLE SWEEP — the harvest half of the accept-vs-waste reward loop.
 *
 * ## The gap this closes
 * Every producer of a human accept/waste label already existed. What did not exist was a way to RUN
 * them. `findChainOutcome` and `findChainResidue` had exactly one caller each — inside the live
 * briefing hook (`src/cli.ts`) — where they settle the PRIOR turn only when a NEW briefing arrives in
 * the SAME conversation. Measured read-only over `~/.scns/memory/experience.db` on 2026-07-31 for rows
 * since 2026-07-27:
 *
 *   arm/author            S0_rows  S1_conv  S2_unsettled  S3_delivered  S4_in_transcript  S5_has_next
 *   magma/machine             676      676           676           656               639            3
 *   magma/human               239      237           234           225               222           21
 *   multihop-iter/human        50       49            48            38                33            5
 *
 *   BRIEFINGS PER CONVERSATION: 911 conversations, 902 (99.0%) carry exactly ONE briefing.
 *
 * So the trigger the harvest depends on fires for 1% of traffic, and 29 fully-eligible pairs (24
 * magma / 5 multihop-iter) sat permanently unlabelled — while the routing learner reported the
 * challenger arms BLOCKED for want of `minN` settled rows. The bottleneck was never exposure
 * (multihop-iter was served 50 times) and never the settle producers themselves (the challenger
 * settles at a HIGHER rate than the incumbent, 1/50 vs 3/915); it was that nothing ever asked them.
 *
 * ## What this module is NOT
 * It is not a measurement harness, a gate, or a report. It writes the north-star reward signal itself
 * and introduces **no new gradient, no new classifier and no new settle path**. Every label still
 * comes from the existing producers, still carries its existing `answer_source` provenance, and is
 * still first-signal-wins at the SQL level, so the oracle-grade labels written synchronously on the
 * briefing path always outrank anything harvested here.
 *
 * ## Precedence and safety, preserved
 *  - **No oracle ⇒ no labels.** A `fallback` transcript means the CLI's own record of what the human
 *    typed is unavailable, and a derived label without ground truth is exactly the authorship
 *    contamination `prompt-authorship.ts` exists to stop. The sweep returns empty.
 *  - **Delivery gate.** Inherited unchanged from {@link findChainCandidates}: a briefing the client
 *    aborted was never seen, so it can never be labelled.
 *  - **Deterministic before derived.** The free, precise chain rules run first; only the pairs they
 *    ABSTAIN on are offered to the ACP follow-up reader, which is separately bounded because it
 *    spawns a subprocess per read.
 *  - **Bounded and re-entrant.** The chain loop tracks the ids it has already offered within the
 *    run; a reader refusal is recorded DURABLY (`followup_refusal` — issue #17, spec 003 US4), so an
 *    abstaining reader (which deliberately leaves the row NULL) can never spin within a run AND
 *    cannot consume the read budget again on following runs. Before that record existed the refusal
 *    memory was a per-run Set, and 283 of 319 live runs settled zero with `followupAbstained` pinned
 *    at exactly `maxReads` — the whole hourly budget re-bought the same permanent refusals.
 */

import {
  hasFollowupRefusal,
  isFollowupDeferred,
  recordFollowupRefusal,
  type ExperienceStore,
} from './experience-store.js'
import type { SessionTranscript } from './session-transcript.js'
import type { FollowupReading } from './followup-satisfaction.js'
import {
  findChainOutcome,
  findChainResidue,
  findUnsettledConversations,
  settleChainOutcome,
  settleFollowupOutcome,
} from './query-chain.js'

/** The ACP follow-up reader, injected so the sweep stays testable and CI-safe (no spawn by default). */
export type FollowupReader = (req: {
  readonly priorQuery: string
  readonly nextTurn: string
}) => Promise<FollowupReading | null>

export interface SettleSweepDeps {
  readonly store: ExperienceStore
  /** The CLI transcript oracle. `fallback` ⇒ the sweep abstains entirely. */
  readonly transcript: SessionTranscript
  /** Omit for a deterministic-only sweep (no subprocess is ever spawned). */
  readonly readFollowup?: FollowupReader
}

export interface SettleSweepOptions {
  /** Conversations to walk in one run. Default 500. */
  readonly maxConversations?: number
  /** Max ACP reads one run may spawn — the cost bound. Default 12. */
  readonly maxReads?: number
  /** The run's logical clock for refusal back-off (#17, FR-008) — it stamps refusals and decides
   *  window expiry. Defaults to real time; injectable so the back-off tests are exact. */
  readonly now?: Date
}

export interface SettleSweepSummary {
  readonly conversationsScanned: number
  /** Rows settled by the deterministic query-chain rules. */
  readonly chainSettled: number
  /** Rows settled by the ACP follow-up reader. */
  readonly followupSettled: number
  /** Eligible pairs the reader declined to label (a deliberate abstain, not a failure). */
  readonly followupAbstained: number
  /** Reads spent on pairs never offered to the reader before (#17, FR-011). */
  readonly readsOnNewPairs: number
  /** Reads spent retrying previously-refused pairs whose back-off recovered (#17, FR-011). */
  readonly readsOnRetriedPairs: number
  /** Eligible pairs skipped WITHOUT spending a read — their refusal back-off still holds (#17). */
  readonly deferredByBackoff: number
  /** Every experience id this run settled — the audit trail. */
  readonly settledIds: readonly number[]
}

const DEFAULT_MAX_READS = 12

const EMPTY: SettleSweepSummary = {
  conversationsScanned: 0,
  chainSettled: 0,
  followupSettled: 0,
  followupAbstained: 0,
  readsOnNewPairs: 0,
  readsOnRetriedPairs: 0,
  deferredByBackoff: 0,
  settledIds: [],
}

/**
 * Walk the unsettled frontier and harvest every labellable pair, bounded. Never throws.
 */
export async function runSettleSweep(
  deps: SettleSweepDeps,
  opts: SettleSweepOptions = {},
): Promise<SettleSweepSummary> {
  // GROUND TRUTH OR NOTHING — see the module note.
  if (deps.transcript?.mode !== 'oracle') return EMPTY

  const maxReads = opts.maxReads ?? DEFAULT_MAX_READS
  const convs = findUnsettledConversations(deps.store, {
    ...(opts.maxConversations !== undefined ? { limit: opts.maxConversations } : {}),
  })

  const settledIds: number[] = []
  let conversationsScanned = 0
  let chainSettled = 0
  let followupSettled = 0
  let followupAbstained = 0
  let readsOnNewPairs = 0
  let readsOnRetriedPairs = 0
  let deferredByBackoff = 0
  let reads = 0

  for (const conv of convs) {
    conversationsScanned++
    const lookup = { conversationId: conv, transcript: deps.transcript }

    // (1) Deterministic rules — free and higher precedence. Drain: settling one row can expose the
    // next eligible pair in the same conversation.
    const offeredChain = new Set<number>()
    for (;;) {
      const outcome = findChainOutcome(deps.store, lookup)
      if (!outcome || offeredChain.has(outcome.experienceId)) break
      offeredChain.add(outcome.experienceId)
      if (settleChainOutcome(deps.store, outcome)) {
        chainSettled++
        settledIds.push(outcome.experienceId)
      }
    }

    // (2) The ABSTAIN RESIDUE — offered to the reader only, and only while budget remains.
    // `excludeIds` is what makes this a DRAIN rather than a single peek: an abstained row keeps its
    // NULL outcome, so without it `findChainResidue` would return the same newest pair forever and
    // every older eligible pair in the conversation would be unreachable. Measured on a copy of the
    // live corpus 2026-07-31: 41 eligible pairs existed, only 17 were reachable newest-first, and 4
    // of the challenger arm's 5 were lost to position alone.
    //
    // The refusal memory itself is DURABLE (#17): a refusal is written to `followup_refusal` and a
    // pair whose back-off still holds is deferred here WITHOUT spending a read. The in-memory
    // `offeredResidue` Set this loop once kept — the cross-run gap that let the same permanent
    // refusals consume the whole budget every hour — is superseded by that record; `resolvedThisRun`
    // below only carries the ids this run has already refused or deferred, so the drain advances.
    if (!deps.readFollowup) continue
    const resolvedThisRun = new Set<number>()
    while (reads < maxReads) {
      const residue = findChainResidue(deps.store, { ...lookup, excludeIds: resolvedThisRun })
      if (!residue || resolvedThisRun.has(residue.experienceId)) break
      const currentTurnCount = deps.transcript.humanTurns(conv).length
      if (
        isFollowupDeferred(deps.store, {
          experienceId: residue.experienceId,
          currentTurnCount,
          ...(opts.now !== undefined ? { now: opts.now } : {}),
        })
      ) {
        deferredByBackoff++
        resolvedThisRun.add(residue.experienceId)
        continue
      }
      const retried = hasFollowupRefusal(deps.store, residue.experienceId)
      reads++
      if (retried) readsOnRetriedPairs++
      else readsOnNewPairs++
      let reading: FollowupReading | null = null
      try {
        reading = await deps.readFollowup({
          priorQuery: residue.priorQuery,
          nextTurn: residue.nextTurn,
        })
      } catch {
        /* a dead worker abstains — it never labels */
      }
      if (!reading) {
        followupAbstained++
        recordFollowupRefusal(deps.store, {
          experienceId: residue.experienceId,
          conversationId: conv,
          turnsAtRefusal: currentTurnCount,
          ...(opts.now !== undefined ? { refusedAt: opts.now } : {}),
        })
        resolvedThisRun.add(residue.experienceId)
        continue
      }
      if (
        settleFollowupOutcome(deps.store, {
          experienceId: residue.experienceId,
          cue: reading.cue,
          pattern: reading.pattern,
          confidence: reading.confidence,
          nextTurnIndex: residue.nextTurnIndex,
        })
      ) {
        followupSettled++
        settledIds.push(residue.experienceId)
      } else {
        // The settle seam refused the verdict (first-signal race, or a gate question landed during
        // the read) — either way the row is not this run's work any more; move the drain along.
        resolvedThisRun.add(residue.experienceId)
      }
    }
  }

  return {
    conversationsScanned,
    chainSettled,
    followupSettled,
    followupAbstained,
    readsOnNewPairs,
    readsOnRetriedPairs,
    deferredByBackoff,
    settledIds,
  }
}

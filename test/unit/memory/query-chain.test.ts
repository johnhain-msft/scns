import { describe, it, expect } from 'vitest'
import {
  openExperienceStore,
  logRetrievalExperience,
  type ExperienceStore,
} from '../../../src/memory/experience-store.js'
import type { SessionTranscript, HumanTurn } from '../../../src/memory/session-transcript.js'
import {
  queryChainSimilarity,
  classifyChainStep,
  findChainCandidates,
  findChainOutcome,
  findChainResidue,
  settleChainOutcome,
  wilsonInterval,
  DEFAULT_DELIVERY_TIMEOUT_MS,
} from '../../../src/memory/query-chain.js'
import {
  setGateQuestion,
  markGateDelivered,
  settleGateAnswered,
} from '../../../src/memory/gate-elicitation.js'
import { HUMAN_OUTCOME_GRADIENT } from '../../../src/memory/human-outcome.js'

// ── The MISSING PRODUCER for 'used' / 'edited' (Radlinski & Joachims, KDD 2005) ───────────────────
// Consecutive human turns in one session form a QUERY CHAIN. A reformulation means the earlier
// briefing did NOT satisfy the need (waste); an approving advance means it did (used). SCNS's N1
// verbatim re-ask detector is the DEGENERATE similarity=1.0 case of chain continuation.
//
// The classifier is itself a model, so it ABSTAINS by default: a bare topic change is not evidence
// of value (Joachims SIGIR 2005 — implicit signals are biased). It also refuses to label a briefing
// the human never received: the installed extension aborts the context call at 1500 ms, and measured
// on the live corpus only 321/664 magma rows (48.3%) finished inside that budget.

const mkTranscript = (turns: readonly HumanTurn[], mode: 'oracle' | 'fallback' = 'oracle'): SessionTranscript => ({
  mode,
  reason: '',
  path: '/tmp/fake-session-store.db',
  humanTurns: () => turns,
  close: () => {},
})

const turn = (turnIndex: number, text: string): HumanTurn => ({ turnIndex, text, timestampMs: null })

/** `latencyMs: null` logs the row with an UNKNOWN latency (the column stays NULL). */
const mk = (
  store: ExperienceStore,
  conversationId: string,
  queryText: string,
  latencyMs: number | null = 200,
  clientTimeoutMs?: number,
): number =>
  logRetrievalExperience(store, {
    queryText,
    levers: { traverse: true, synthesize: true },
    retrievedChunkIds: [1, 2],
    conversationId,
    ...(latencyMs !== null ? { latencyMs } : {}),
    ...(clientTimeoutMs !== undefined ? { clientTimeoutMs } : {}),
  })

describe('queryChainSimilarity — the chain-continuation signal (Radlinski top feature: cosine)', () => {
  it('is 1.0 for a verbatim re-ask (the degenerate N1 case)', () => {
    const q = 'How do I restart the SCNS broker safely?'
    expect(queryChainSimilarity(q, q)).toBe(1)
  })

  it('stays high for a reformulation of the same information need', () => {
    const sim = queryChainSimilarity(
      'How do I restart the SCNS broker safely?',
      'how do i restart the scns broker without losing state',
    )
    expect(sim).toBeGreaterThanOrEqual(0.55)
  })

  it('is low for an unrelated follow-up', () => {
    const sim = queryChainSimilarity(
      'How do I restart the SCNS broker safely?',
      'write the release notes for version 2 of the dashboard',
    )
    expect(sim).toBeLessThan(0.2)
  })

  it('ignores stopwords rather than scoring on them', () => {
    expect(
      queryChainSimilarity('the a of and is it', 'the a of and is it to be'),
    ).toBe(0)
  })
})

describe('classifyChainStep — rule order, high precision, ABSTAIN by default', () => {
  it('RULE 1 reformulation ⇒ re-asked (waste): the chain continued, so the briefing failed', () => {
    const v = classifyChainStep(
      'How do I restart the SCNS broker safely?',
      'how do i restart the scns broker without losing state',
    )
    expect(v?.cue).toBe('re-asked')
    expect(v?.rule).toBe('reformulation')
  })

  it('RULE 2 correction marker ⇒ edited (accepted with friction)', () => {
    const v = classifyChainStep(
      'Summarize the retrieval experience schema',
      'no, I meant the reward learner — give me its arm selection instead',
    )
    expect(v?.cue).toBe('edited')
    expect(v?.rule).toBe('correction')
  })

  it('RULE 3 affirmation + topic advance ⇒ used (the need was served)', () => {
    const v = classifyChainStep(
      'How do I restart the SCNS broker safely?',
      'perfect, now write the release notes for the dashboard',
    )
    expect(v?.cue).toBe('used')
    expect(v?.rule).toBe('affirmed-advance')
  })

  it('NEGATIVE CONTROL: a bare topic change with no marker does NOT fire — it abstains', () => {
    expect(
      classifyChainStep(
        'How do I restart the SCNS broker safely?',
        'write the release notes for version 2 of the dashboard',
      ),
    ).toBeNull()
  })

  it('NEGATIVE CONTROL: a too-short next turn never labels anything', () => {
    expect(classifyChainStep('How do I restart the SCNS broker safely?', 'ok')).toBeNull()
    expect(classifyChainStep('How do I restart the SCNS broker safely?', '')).toBeNull()
  })

  it('reformulation OUTRANKS a correction marker — the same need restated is still a failure', () => {
    const v = classifyChainStep(
      'How do I restart the SCNS broker safely?',
      'no, how do I restart the SCNS broker safely without dropping state?',
    )
    expect(v?.cue).toBe('re-asked')
  })
})

describe('findChainOutcome — binds a cue to the EXACT prior attempt id', () => {
  it('POSITIVE: resolves the prior row from the transcript and reports provenance', () => {
    const store = openExperienceStore(':memory:')
    const prior = mk(store, 'sess-A', 'How do I restart the SCNS broker safely?')
    const t = mkTranscript([
      turn(0, 'How do I restart the SCNS broker safely?'),
      turn(1, 'perfect, now write the release notes for the dashboard'),
    ])
    const out = findChainOutcome(store, { conversationId: 'sess-A', transcript: t })
    expect(out?.experienceId).toBe(prior)
    expect(out?.cue).toBe('used')
    expect(out?.source).toMatch(/^query-chain:affirmed-advance:turn-1:sim-/)
    store.close()
  })

  it('DELIVERY GATE: a row slower than the extension abort is NEVER labeled', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'How do I restart the SCNS broker safely?', DEFAULT_DELIVERY_TIMEOUT_MS + 1)
    const t = mkTranscript([
      turn(0, 'How do I restart the SCNS broker safely?'),
      turn(1, 'perfect, now write the release notes for the dashboard'),
    ])
    expect(findChainOutcome(store, { conversationId: 'sess-A', transcript: t })).toBeNull()
    store.close()
  })

  it('DELIVERY GATE: an unknown (NULL) latency abstains rather than guessing', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'How do I restart the SCNS broker safely?', null)
    const t = mkTranscript([
      turn(0, 'How do I restart the SCNS broker safely?'),
      turn(1, 'perfect, now write the release notes for the dashboard'),
    ])
    expect(findChainOutcome(store, { conversationId: 'sess-A', transcript: t })).toBeNull()
    store.close()
  })

  it('never re-labels an already-settled row (first-signal-wins is upstream truth)', () => {
    const store = openExperienceStore(':memory:')
    const prior = mk(store, 'sess-A', 'How do I restart the SCNS broker safely?')
    store.db.prepare('UPDATE retrieval_experience SET human_outcome = 1.0 WHERE id = ?').run(prior)
    const t = mkTranscript([
      turn(0, 'How do I restart the SCNS broker safely?'),
      turn(1, 'perfect, now write the release notes for the dashboard'),
    ])
    expect(findChainOutcome(store, { conversationId: 'sess-A', transcript: t })).toBeNull()
    store.close()
  })

  it('requires a transcript ORACLE — fallback mode never fabricates a chain', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'How do I restart the SCNS broker safely?')
    const t = mkTranscript(
      [
        turn(0, 'How do I restart the SCNS broker safely?'),
        turn(1, 'perfect, now write the release notes for the dashboard'),
      ],
      'fallback',
    )
    expect(findChainOutcome(store, { conversationId: 'sess-A', transcript: t })).toBeNull()
    expect(findChainOutcome(store, { conversationId: 'sess-A', transcript: null })).toBeNull()
    store.close()
  })

  it('needs a session scope and a LATER human turn', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'How do I restart the SCNS broker safely?')
    const onlyOne = mkTranscript([turn(0, 'How do I restart the SCNS broker safely?')])
    expect(findChainOutcome(store, { conversationId: 'sess-A', transcript: onlyOne })).toBeNull()
    expect(findChainOutcome(store, { conversationId: undefined, transcript: onlyOne })).toBeNull()
    store.close()
  })

  it('a query absent from the transcript is a MACHINE briefing — never labeled', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'Sub-agent brief: enumerate every retriever arm and report back')
    const t = mkTranscript([
      turn(0, 'How do I restart the SCNS broker safely?'),
      turn(1, 'perfect, now write the release notes for the dashboard'),
    ])
    expect(findChainOutcome(store, { conversationId: 'sess-A', transcript: t })).toBeNull()
    store.close()
  })

  it('is FAIL-SAFE: a broken store returns null instead of throwing into the briefing path', () => {
    const store = openExperienceStore(':memory:')
    store.db.exec('DROP TABLE retrieval_experience')
    const t = mkTranscript([turn(0, 'a'), turn(1, 'b')])
    expect(() => findChainOutcome(store, { conversationId: 'sess-A', transcript: t })).not.toThrow()
    expect(findChainOutcome(store, { conversationId: 'sess-A', transcript: t })).toBeNull()
    store.close()
  })
})

/**
 * The delivery gate must use the budget the CLIENT ACTUALLY ENFORCED on that request, not a global
 * guess. The extension's abort budget changed 1500 -> 5000, and both populations coexist: sessions
 * started before the change still abort at 1500. Inferring the budget from wall-clock cutover would
 * mark undelivered rows as delivered — fabricating labels. So the client reports its own budget and
 * the row records it; rows without one keep the conservative 1500 default.
 */
describe('findChainOutcome — per-row delivery budget (recorded, never inferred)', () => {
  const chain = [
    turn(0, 'How do I restart the SCNS broker safely?'),
    turn(1, 'How do I restart the SCNS broker without dropping sessions?'),
  ]

  it('honors a RECORDED budget upward: 3000ms is delivered when the client allowed 5000', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', 'How do I restart the SCNS broker safely?', 3000, 5000)
    const got = findChainOutcome(store, { conversationId: 'sess-A', transcript: mkTranscript(chain) })
    expect(got?.experienceId).toBe(id)
    expect(got?.cue).toBe('re-asked')
    store.close()
  })

  it('NEGATIVE CONTROL: the same 3000ms row with NO recorded budget stays rejected at the 1500 default', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'How do I restart the SCNS broker safely?', 3000)
    expect(
      findChainOutcome(store, { conversationId: 'sess-A', transcript: mkTranscript(chain) }),
    ).toBeNull()
    store.close()
  })

  it('honors a RECORDED budget DOWNWARD: a client that allowed only 1500 still rejects 3000', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'How do I restart the SCNS broker safely?', 3000, 1500)
    expect(
      findChainOutcome(store, { conversationId: 'sess-A', transcript: mkTranscript(chain) }),
    ).toBeNull()
    store.close()
  })

  it('the recorded budget WINS over a caller-supplied default — it is ground truth, not a guess', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'How do I restart the SCNS broker safely?', 3000, 1500)
    expect(
      findChainOutcome(store, {
        conversationId: 'sess-A',
        transcript: mkTranscript(chain),
        deliveryTimeoutMs: 60_000,
      }),
    ).toBeNull()
    store.close()
  })

  it('still refuses a row with UNKNOWN latency even when the client reported a budget', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'How do I restart the SCNS broker safely?', null, 5000)
    expect(
      findChainOutcome(store, { conversationId: 'sess-A', transcript: mkTranscript(chain) }),
    ).toBeNull()
    store.close()
  })
})

describe('settleChainOutcome — the EXISTING seam plus provenance', () => {
  const chainOf = (store: ExperienceStore, next: string) => {
    const prior = mk(store, 'sess-A', 'How do I restart the SCNS broker safely?')
    const t = mkTranscript([turn(0, 'How do I restart the SCNS broker safely?'), turn(1, next)])
    return { prior, outcome: findChainOutcome(store, { conversationId: 'sess-A', transcript: t }) }
  }

  it('writes the cue through humanOutcomeOfCue and stamps a query-chain: provenance', () => {
    const store = openExperienceStore(':memory:')
    const { prior, outcome } = chainOf(store, 'perfect, now write the release notes for the dashboard')
    expect(settleChainOutcome(store, outcome!)).toBe(true)
    const row = store.db
      .prepare('SELECT human_outcome, answer_source FROM retrieval_experience WHERE id = ?')
      .get(prior) as { human_outcome: number; answer_source: string }
    expect(row.human_outcome).toBe(HUMAN_OUTCOME_GRADIENT.accepted)
    expect(row.answer_source).toMatch(/^query-chain:affirmed-advance:/)
    store.close()
  })

  it('a correction settles the previously-unreachable acceptedEdited anchor', () => {
    const store = openExperienceStore(':memory:')
    const { prior, outcome } = chainOf(store, 'no, I meant the reward learner arm selection instead')
    expect(outcome?.cue).toBe('edited')
    expect(settleChainOutcome(store, outcome!)).toBe(true)
    const row = store.db
      .prepare('SELECT human_outcome FROM retrieval_experience WHERE id = ?')
      .get(prior) as { human_outcome: number }
    expect(row.human_outcome).toBe(HUMAN_OUTCOME_GRADIENT.acceptedEdited)
    store.close()
  })

  it('PROVENANCE NEVER BLURS: derived labels are distinguishable from transcript-oracle ones', () => {
    const store = openExperienceStore(':memory:')
    const { outcome } = chainOf(store, 'perfect, now write the release notes for the dashboard')
    expect(outcome!.source.startsWith('transcript-oracle:')).toBe(false)
    expect(outcome!.source.startsWith('query-chain:')).toBe(true)
    store.close()
  })

  it('refuses to overwrite an already-settled row (first-signal-wins) and leaves it unannotated', () => {
    const store = openExperienceStore(':memory:')
    const { prior, outcome } = chainOf(store, 'perfect, now write the release notes for the dashboard')
    store.db.prepare('UPDATE retrieval_experience SET human_outcome = 0.2 WHERE id = ?').run(prior)
    expect(settleChainOutcome(store, outcome!)).toBe(false)
    const row = store.db
      .prepare('SELECT human_outcome, answer_source FROM retrieval_experience WHERE id = ?')
      .get(prior) as { human_outcome: number; answer_source: string | null }
    expect(row.human_outcome).toBe(0.2)
    expect(row.answer_source).toBeNull()
    store.close()
  })
})

describe('wilsonInterval — the baseline must ship with a confidence interval', () => {
  it('brackets the point estimate and stays inside [0,1]', () => {
    const ci = wilsonInterval(8, 17)
    expect(ci.point).toBeCloseTo(8 / 17, 10)
    expect(ci.low).toBeGreaterThanOrEqual(0)
    expect(ci.high).toBeLessThanOrEqual(1)
    expect(ci.low).toBeLessThan(ci.point)
    expect(ci.high).toBeGreaterThan(ci.point)
  })

  it('is WIDE at small n — the honest report of a thin baseline', () => {
    expect(wilsonInterval(1, 2).high - wilsonInterval(1, 2).low).toBeGreaterThan(
      wilsonInterval(50, 100).high - wilsonInterval(50, 100).low,
    )
  })

  it('returns a degenerate full-width interval for n = 0 rather than NaN', () => {
    const ci = wilsonInterval(0, 0)
    expect(Number.isNaN(ci.point)).toBe(false)
    expect(ci.low).toBe(0)
    expect(ci.high).toBe(1)
  })
})

// ── US2 / issue #16 — A HUMAN ANSWER IN FLIGHT BEATS EVERY DERIVED GUESS ─────────────────────────
//
// Replay of LIVE row 1883, read read-only from `~/.scns/memory/experience.db`. Two moments matter
// here and the row looks different in each, so both are stated rather than blended.
//
// SETTLED state, as the row reads today (re-verified read-only 2026-08-05, unchanged from 2026-08-04):
//
//   id=1883  latency_ms=2064  client_timeout_ms=5000  explore_arm='multihop-iter'  retriever='magma'
//   gate_delivered=1  gate_question IS NOT NULL  human_outcome=1
//   answer_source='human-direct:conv-34894b49:relayed-by-agent'
//
// EXPOSURE WINDOW — the earlier state this test actually replays. `human_outcome` was still NULL
// with a delivered question outstanding: the row sat delivered-and-unanswered on the challenger arm
// while the hourly harvest ran. That is the only state in which the guard can act, so it is the
// state the fixtures reconstruct; the settled row above is what the window resolved TO, not what
// the harvest saw.
//
// This row is the one that completed the challenger's quorum, and the correct label happened
// because the human answered FIRST — not because anything stopped the alternative. `human_outcome`
// is write-once / first-signal-wins (data-model V2), so a derived label landing inside that window
// does not merely arrive early: it REFUSES the real answer permanently and loses `elicited_intent`
// with it. The settled `answer_source` above is the evidence of which signal won the race.
//
// FR-002 is why these assertions target `findChainCandidates` as well as the two producers: the guard
// has to live in the one shared eligibility pass, so that a producer added tomorrow inherits it
// instead of having to remember it.
//
// PROVENANCE, corrected 2026-08-05 (judge finding 1). The commit that added this block said "nothing
// in the suite would have caught someone moving it back into one caller, or narrowing the predicate."
// The first half is false: `settle-precedence-race.test.ts` already carries
// `describe('DP-F1 [US2] the guard lives in the SHARED eligibility pass, not one caller')`, and it
// shipped in `a0b89ad` — the hoist commit itself — so the de-hoist net existed from day one. What is
// added here is DEPTH on top of that net (the live-row replay, the 2x2 causal isolation, the relayed
// answer, the fail-safe), not the net. The second half WAS true when written — nothing distinguished
// `gate_question IS NOT NULL` from `… AND gate_delivered = 1`, because every fixture here is a replay
// of row 1883 and row 1883 was delivered. T042 below is what finally makes that half false too.
/**
 * FIXTURE-LOCAL conversation key — NOT row 1883's `conversation_id`.
 *
 * Corrected 2026-08-05 (judge N1). The live row's conversation is
 * `db0dec35-ebd9-4bf0-812b-da3f447d76e0`; `conv-34894b49` occurs only INSIDE its `answer_source`
 * string. The tests below need some conversation key and this one keeps `R1883_RELAY_SOURCE`
 * byte-identical to the live value, so it is kept — but it is a fixture key that happens to reuse
 * the embedded token, not a replayed field. Nothing here reads `conversation_id` for meaning, so
 * this has no behavioural consequence; it is recorded because the rest of this header claims
 * field-level fidelity and this one line does not have it.
 */
const R1883_CONV = 'conv-34894b49'
const R1883_PROMPT = "yes run the suite and then summarize what we've done so far."
const R1883_LATENCY_MS = 2064
const R1883_CLIENT_TIMEOUT_MS = 5000
const R1883_ARM = 'multihop-iter'
const R1883_QUESTION = 'Which suite do you mean — unit, integration, or e2e?'
const R1883_ANSWER = '"suite" can mean a multitude of things in this repo — I mean the unit suite.'
/**
 * The channel the live row actually recorded: relayed by an agent, not typed into the transcript.
 * Reconstructed rather than quoted, but byte-identical to the live `answer_source`.
 */
const R1883_RELAY_SOURCE = `human-direct:${R1883_CONV}:relayed-by-agent`
/** Classifies as affirmed-advance ⇒ the DETERMINISTIC producer (`findChainOutcome`) wants this row. */
const NEXT_AFFIRM = 'perfect, now write the release notes for the dashboard'
/** `/^(ok|okay)\b/` does not match "okayu" ⇒ the rules abstain ⇒ the RESIDUE producer wants this row. */
const NEXT_ABSTAIN = 'okayu -- so we need to handoff to a new session that can audit aand suggest some fixes?'

/**
 * Row 1883 rebuilt exactly as the store held it. `withQuestion` is the ONLY thing that differs between
 * the two arms of every test below — which is what makes an exclusion attributable to the guard rather
 * than to a fixture that was never eligible in the first place. Each test proves that eligibility
 * positively rather than assuming it.
 *
 * `deliver` defaults to true, which is row 1883's own shape. Passing `false` builds the ASKED-but-not-
 * yet-DELIVERED state, which exists to keep the predicate honest — see T042.
 */
function replayRow1883(
  store: ExperienceStore,
  opts: { readonly withQuestion: boolean; readonly nextTurn: string; readonly deliver?: boolean },
): { id: number; transcript: SessionTranscript } {
  const id = mk(store, R1883_CONV, R1883_PROMPT, R1883_LATENCY_MS, R1883_CLIENT_TIMEOUT_MS)
  store.db.prepare('UPDATE retrieval_experience SET explore_arm = ? WHERE id = ?').run(R1883_ARM, id)
  if (opts.withQuestion) {
    expect(setGateQuestion(store, id, R1883_QUESTION)).toBe(true)
    if (opts.deliver !== false) {
      const delivery = mk(
        store,
        R1883_CONV,
        'and what does the census say about the escalated pool?',
        R1883_LATENCY_MS,
        R1883_CLIENT_TIMEOUT_MS,
      )
      expect(markGateDelivered(store, id, { deliveredByExperienceId: delivery })).toBe(true)
    }
  }
  return { id, transcript: mkTranscript([turn(0, R1883_PROMPT), turn(1, opts.nextTurn)]) }
}

const gateDeliveredOf = (store: ExperienceStore, id: number): number =>
  (
    store.db
      .prepare('SELECT gate_delivered AS v FROM retrieval_experience WHERE id = ?')
      .get(id) as { v: number }
  ).v

const humanOutcomeOf = (store: ExperienceStore, id: number): number | null =>
  (
    store.db.prepare('SELECT human_outcome AS v FROM retrieval_experience WHERE id = ?').get(id) as {
      v: number | null
    }
  ).v

const candidateIds = (store: ExperienceStore, transcript: SessionTranscript): number[] =>
  findChainCandidates(store, { conversationId: R1883_CONV, transcript }).map((c) => c.experienceId)

describe('#16 — an unanswered clarifying question is not labellable by ANY producer (row 1883 replay)', () => {
  it('T037 RED: the DETERMINISTIC producer must not pre-empt the pending question', () => {
    const store = openExperienceStore(':memory:')

    // POSITIVE CONTROL FIRST: without the question this exact record IS labellable, so a null below
    // is the guard doing its job and not a fixture that never qualified.
    const open = openExperienceStore(':memory:')
    const control = replayRow1883(open, { withQuestion: false, nextTurn: NEXT_AFFIRM })
    expect(
      findChainOutcome(open, { conversationId: R1883_CONV, transcript: control.transcript })
        ?.experienceId,
    ).toBe(control.id)
    open.close()

    const { id, transcript } = replayRow1883(store, { withQuestion: true, nextTurn: NEXT_AFFIRM })
    expect(candidateIds(store, transcript)).not.toContain(id)
    expect(findChainOutcome(store, { conversationId: R1883_CONV, transcript })).toBeNull()
    expect(humanOutcomeOf(store, id)).toBeNull()
    store.close()
  })

  it('T037 RED: the RESIDUE producer must not pre-empt it either', () => {
    const store = openExperienceStore(':memory:')

    const open = openExperienceStore(':memory:')
    const control = replayRow1883(open, { withQuestion: false, nextTurn: NEXT_ABSTAIN })
    expect(findChainOutcome(open, { conversationId: R1883_CONV, transcript: control.transcript })).toBeNull()
    expect(
      findChainResidue(open, { conversationId: R1883_CONV, transcript: control.transcript })
        ?.experienceId,
    ).toBe(control.id)
    open.close()

    const { id, transcript } = replayRow1883(store, { withQuestion: true, nextTurn: NEXT_ABSTAIN })
    expect(candidateIds(store, transcript)).not.toContain(id)
    expect(findChainResidue(store, { conversationId: R1883_CONV, transcript })).toBeNull()
    expect(humanOutcomeOf(store, id)).toBeNull()
    store.close()
  })

  it('T038 POSITIVE CONTROL (FR-003): once the answer is recorded the record settles, and the HUMAN answer is the label of record', () => {
    const store = openExperienceStore(':memory:')
    const { id, transcript } = replayRow1883(store, { withQuestion: true, nextTurn: NEXT_AFFIRM })
    expect(findChainOutcome(store, { conversationId: R1883_CONV, transcript })).toBeNull()

    expect(settleGateAnswered(store, id, R1883_ANSWER, R1883_RELAY_SOURCE)).toBe(true)

    const row = store.db
      .prepare(
        'SELECT human_outcome, answer_source, elicited_intent FROM retrieval_experience WHERE id = ?',
      )
      .get(id) as { human_outcome: number; answer_source: string; elicited_intent: string }
    expect(row.human_outcome).toBe(HUMAN_OUTCOME_GRADIENT.accepted)
    expect(row.answer_source).toBe(R1883_RELAY_SOURCE)
    expect(row.elicited_intent).toBe(R1883_ANSWER)

    // The derived producers stay out, and the write-once seam refuses to overwrite the human's label.
    expect(candidateIds(store, transcript)).not.toContain(id)
    expect(
      settleChainOutcome(store, {
        experienceId: id,
        cue: 'used',
        rule: 'affirmed-advance',
        similarity: 1,
        source: 'query-chain:affirmed-advance:turn-1:sim-1.00',
      }),
    ).toBe(false)
    expect(humanOutcomeOf(store, id)).toBe(HUMAN_OUTCOME_GRADIENT.accepted)
    store.close()
  })

  it('T039 NEGATIVE CONTROL (FR-003 / AS-3): a settled record is excluded by its SETTLED state, not by the presence of a question', () => {
    // The 2x2 isolates the variable. If question-presence were what excluded settled records, the
    // no-question settled cell would come back eligible — it does not; settledness alone excludes.
    const eligible = (withQuestion: boolean, settled: boolean): number[] => {
      const store = openExperienceStore(':memory:')
      const { id, transcript } = replayRow1883(store, { withQuestion, nextTurn: NEXT_ABSTAIN })
      if (settled)
        store.db
          .prepare('UPDATE retrieval_experience SET human_outcome = 1.0 WHERE id = ?')
          .run(id)
      const ids = candidateIds(store, transcript).filter((c) => c === id)
      store.close()
      return ids
    }
    expect(eligible(true, true)).toEqual([]) // answered + settled → excluded
    expect(eligible(false, true)).toEqual([]) // settled, no question ever → excluded ALL THE SAME
    expect(eligible(true, false)).toEqual([]) // question outstanding → protected (A5)
    expect(eligible(false, false)).toEqual([expect.any(Number)]) // the fixture really is eligible
  })

  it('T039 NEGATIVE CONTROL: the guard is not a permanent seal — it is recomputed from current row state, so a RESOLVED question restores eligibility', () => {
    // DESIGN-INVARIANT PIN, not a replay of a reachable flow. Verified 2026-08-05: no production writer
    // clears `gate_question` (`gate-elicitation.ts` only ever SETs it, `WHERE gate_question IS NULL`) and
    // none un-settles a row (`experience-store.ts` is the single `human_outcome` writer, write-once,
    // `WHERE human_outcome IS NULL`, and never writes NULL). So this transition cannot occur today.
    // It is pinned anyway because it is the ONLY thing that makes FR-003's "MUST NOT be a permanent
    // exclusion" falsifiable: it proves protection is a pure function of the row as it stands right now,
    // with no cached or per-record seal. If a resolution path is ever added, this is already its contract.
    const store = openExperienceStore(':memory:')
    const { id, transcript } = replayRow1883(store, { withQuestion: true, nextTurn: NEXT_ABSTAIN })
    expect(candidateIds(store, transcript)).not.toContain(id)

    // FR-003's "answered, settled, OR OTHERWISE RESOLVED". Nothing else about the row changes.
    store.db.prepare('UPDATE retrieval_experience SET gate_question = NULL WHERE id = ?').run(id)
    expect(candidateIds(store, transcript)).toContain(id)
    store.close()
  })

  it('T041 FAIL-SAFE (FR-005): when the protection check itself throws, the record is treated as PROTECTED', () => {
    const store = openExperienceStore(':memory:')
    const { id, transcript } = replayRow1883(store, { withQuestion: false, nextTurn: NEXT_AFFIRM })
    // Positive control: on the healthy store this record IS labellable.
    expect(candidateIds(store, transcript)).toContain(id)

    // Break ONLY the protection query. The candidate SELECT does not mention `gate_question`, so the
    // row still reaches the guard — and the guard's own catch must answer "protected", not "clear".
    const broken: ExperienceStore = {
      ...store,
      db: {
        prepare: (sql: string) => {
          if (sql.includes('gate_question')) throw new Error('protection check unavailable')
          return store.db.prepare(sql)
        },
      } as unknown as ExperienceStore['db'],
    }
    expect(() => findChainOutcome(broken, { conversationId: R1883_CONV, transcript })).not.toThrow()
    expect(candidateIds(broken, transcript)).toEqual([])
    expect(findChainOutcome(broken, { conversationId: R1883_CONV, transcript })).toBeNull()
    expect(findChainResidue(broken, { conversationId: R1883_CONV, transcript })).toBeNull()
    expect(humanOutcomeOf(store, id)).toBeNull()
    store.close()
  })

  it('T042 the predicate is NOT narrowed to `gate_delivered = 1` — an ASKED but UNDELIVERED question protects too', () => {
    // JUDGE 2026-08-05, finding 2. T037-T041 all replay row 1883, and row 1883 was DELIVERED — so
    // every protected fixture above carries `gate_delivered = 1` and none of them can tell
    // `gate_question IS NOT NULL` apart from `gate_question IS NOT NULL AND gate_delivered = 1`.
    // A judge narrowed the predicate to exactly that and every one of those tests still passed.
    // Decision 6 (John, 2026-08-01) says the predicate is deliberately NOT narrowed; this is the
    // test that makes that decision load-bearing instead of a sentence in a commit message.
    //
    // The window matters on its own terms: between generating a question and delivering it, the
    // human answer is already inflight in intent even though nothing has reached him yet. Since
    // `human_outcome` is first-signal-wins, a derived label landing in that window refuses an
    // answer that was about to be asked for — the widest and least visible part of the race.
    const open = openExperienceStore(':memory:')
    const control = replayRow1883(open, { withQuestion: false, nextTurn: NEXT_AFFIRM })
    expect(candidateIds(open, control.transcript)).toContain(control.id)
    open.close()

    const store = openExperienceStore(':memory:')
    const { id, transcript } = replayRow1883(store, {
      withQuestion: true,
      deliver: false,
      nextTurn: NEXT_AFFIRM,
    })

    // The fixture is the point, so assert it rather than trusting it: question set, NOT delivered.
    expect(gateDeliveredOf(store, id)).toBe(0)

    expect(candidateIds(store, transcript)).not.toContain(id)
    expect(findChainOutcome(store, { conversationId: R1883_CONV, transcript })).toBeNull()
    expect(findChainResidue(store, { conversationId: R1883_CONV, transcript })).toBeNull()
    expect(humanOutcomeOf(store, id)).toBeNull()
    store.close()
  })

  it('T041b the FAIL-SAFE is the GUARD\u2019s own, not the outer catch — a healthy row survives a poisoned one', () => {
    // JUDGE 2026-08-05, finding 3. T041 asserts `candidateIds === []`, which the outer
    // `catch { return [] }` in `findChainCandidates` produces just as readily as the guard's inner
    // `catch { return true }` — deleting the inner fail-safe entirely left T041 green. The two
    // shapes only diverge when ANOTHER row is eligible: the guard skips one row and keeps going,
    // whereas a propagating throw takes the whole pass down with it.
    const store = openExperienceStore(':memory:')
    const poisonedPrompt = R1883_PROMPT
    const healthyPrompt = 'and separately, what is the current backfill slot count?'
    const poisoned = mk(store, R1883_CONV, poisonedPrompt, R1883_LATENCY_MS, R1883_CLIENT_TIMEOUT_MS)
    const healthy = mk(store, R1883_CONV, healthyPrompt, R1883_LATENCY_MS, R1883_CLIENT_TIMEOUT_MS)
    const transcript = mkTranscript([
      turn(0, poisonedPrompt),
      turn(1, NEXT_AFFIRM),
      turn(2, healthyPrompt),
      turn(3, NEXT_AFFIRM),
    ])

    // POSITIVE CONTROL: on the healthy store BOTH rows are labellable, so an absence below is
    // attributable to the poisoning and not to a fixture that never qualified.
    expect(candidateIds(store, transcript)).toEqual(expect.arrayContaining([poisoned, healthy]))

    // Break the protection lookup for ONE experience id only. `prepare` sees just the SQL, so the
    // discrimination has to happen at `get(id)` — which is exactly where the guard passes the id.
    const broken: ExperienceStore = {
      ...store,
      db: {
        prepare: (sql: string) => {
          const stmt = store.db.prepare(sql)
          if (!sql.includes('gate_question')) return stmt
          return {
            get: (...args: unknown[]) => {
              if (args[0] === poisoned) throw new Error('protection check unavailable')
              return (stmt as unknown as { get: (...a: unknown[]) => unknown }).get(...args)
            },
            all: (...args: unknown[]) =>
              (stmt as unknown as { all: (...a: unknown[]) => unknown }).all(...args),
            run: (...args: unknown[]) =>
              (stmt as unknown as { run: (...a: unknown[]) => unknown }).run(...args),
          }
        },
      } as unknown as ExperienceStore['db'],
    }

    const ids = candidateIds(broken, transcript)
    // Without the guard's own catch the throw escapes to the outer one and BOTH ids vanish, so this
    // line is the whole test: the fail-safe protects a row, it does not abort the pass.
    expect(ids).toContain(healthy)
    expect(ids).not.toContain(poisoned)
    expect(humanOutcomeOf(store, poisoned)).toBeNull()
    store.close()
  })
})

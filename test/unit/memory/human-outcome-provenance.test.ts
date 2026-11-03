import { describe, it, expect } from 'vitest'
import {
  openExperienceStore,
  logRetrievalExperience,
  settleHumanOutcome,
} from '../../../src/memory/experience-store.js'
import {
  settleHumanOutcomeForAttempt,
  settleHumanOutcomeForEntity,
} from '../../../src/memory/human-outcome.js'
import { settleChainOutcome, settleFollowupOutcome } from '../../../src/memory/query-chain.js'
import { settleGateAnswered } from '../../../src/memory/gate-elicitation.js'

// ── C1 [FR-034/SC-009] — a settled label MUST carry its provenance, written in the SAME statement.
//
// The pre-existing pattern was "settle first, annotate after": two statements, with the annotation
// documented as best-effort and its error swallowed (query-chain.ts:401, :444, gate-elicitation.ts:451).
// That leaves two ways to produce a label with permanently NULL provenance — a crash between the
// statements, or a throw on the second — and two callers that never annotate at all
// (cli.ts:1352 re-ask, outcome-writer.ts:181 entity). A label whose source is unknown cannot be
// down-weighted, so it is consumed as if it were an oracle-grade human verdict.

/** Observed verbatim in the live corpus as prompt_origin='machine'. */
const MACHINE_PROMPT = 'You are a strict news-desk fact-checker for a daily briefing'
const HUMAN_PROMPT = 'why did the auto-merger revert my branch'

const originOf = (store: ReturnType<typeof openExperienceStore>, id: number): string | null =>
  (
    store.db.prepare(`SELECT prompt_origin AS o FROM retrieval_experience WHERE id = ?`).get(id) as {
      o: string | null
    }
  ).o

const rowOf = (
  store: ReturnType<typeof openExperienceStore>,
  id: number,
): { human_outcome: number | null; answer_source: string | null } =>
  store.db
    .prepare(`SELECT human_outcome, answer_source FROM retrieval_experience WHERE id = ?`)
    .get(id) as { human_outcome: number | null; answer_source: string | null }

describe('C1 — settleHumanOutcome writes label and provenance in one statement', () => {
  it('POSITIVE CONTROL: stamps human_outcome and answer_source together', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, {
      queryText: HUMAN_PROMPT,
      levers: {},
      retrievedChunkIds: [1],
    })
    expect(originOf(store, id)).toBe('human') // fixture self-check

    expect(settleHumanOutcome(store, id, 0.0, 'human-reask:turn-7')).toBe(true)

    const row = rowOf(store, id)
    expect(row.human_outcome).toBe(0.0)
    expect(row.answer_source).toBe('human-reask:turn-7')
    store.close()
  })

  it('NEGATIVE CONTROL: omitting the source leaves answer_source NULL and still settles', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, {
      queryText: HUMAN_PROMPT,
      levers: {},
      retrievedChunkIds: [1],
    })
    expect(settleHumanOutcome(store, id, 1.0)).toBe(true)
    const row = rowOf(store, id)
    expect(row.human_outcome).toBe(1.0)
    expect(row.answer_source).toBeNull()
    store.close()
  })

  it('NEGATIVE CONTROL: a machine-origin row is refused — NEITHER column is written', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, {
      queryText: MACHINE_PROMPT,
      levers: {},
      retrievedChunkIds: [1],
    })
    expect(originOf(store, id)).toBe('machine') // fixture self-check

    expect(settleHumanOutcome(store, id, 1.0, 'transcript-oracle:turn-2')).toBe(false)

    const row = rowOf(store, id)
    expect(row.human_outcome).toBeNull()
    expect(row.answer_source).toBeNull() // provenance must not leak onto a refused row
    store.close()
  })

  it('first-signal-wins: a second settle changes NEITHER the label nor the provenance', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, {
      queryText: HUMAN_PROMPT,
      levers: {},
      retrievedChunkIds: [1],
    })
    expect(settleHumanOutcome(store, id, 0.0, 'human-reask:turn-3')).toBe(true)
    expect(settleHumanOutcome(store, id, 1.0, 'transcript-oracle:turn-9')).toBe(false)

    const row = rowOf(store, id)
    expect(row.human_outcome).toBe(0.0)
    expect(row.answer_source).toBe('human-reask:turn-3')
    store.close()
  })
})

describe('C1 — settleHumanOutcomeForAttempt carries provenance through the per-attempt seam', () => {
  it('POSITIVE CONTROL: the cli.ts re-ask path can stamp its own source', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, {
      queryText: HUMAN_PROMPT,
      levers: {},
      retrievedChunkIds: [1],
    })
    expect(settleHumanOutcomeForAttempt(store, id, 're-asked', 'human-reask:turn-4')).toBe(true)

    const row = rowOf(store, id)
    expect(row.human_outcome).toBe(0.2) // 're-asked' maps to waste (0.2), not hardWaste (0.0)
    expect(row.answer_source).toBe('human-reask:turn-4')
    store.close()
  })
})

describe('C1 + Q4 — settleHumanOutcomeForEntity: provenance AND the machine-origin refusal', () => {
  it('POSITIVE CONTROL: stamps provenance on the rows it settles', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, {
      queryText: 'the auto-merger keeps reverting',
      levers: {},
      retrievedChunkIds: [1],
    })
    const settled = settleHumanOutcomeForEntity(store, {
      entity: 'auto-merger',
      value: 1.0,
      answerSource: 'proposal-outcome:implemented',
    })
    expect(settled).toEqual([id])

    const row = rowOf(store, id)
    expect(row.human_outcome).toBe(1.0)
    expect(row.answer_source).toBe('proposal-outcome:implemented')
    store.close()
  })

  it('Q4 NEGATIVE CONTROL: refuses machine-origin rows that the per-attempt path already refuses', () => {
    const store = openExperienceStore(':memory:')
    const machineId = logRetrievalExperience(store, {
      queryText: `${MACHINE_PROMPT} about the auto-merger`,
      levers: {},
      retrievedChunkIds: [1],
    })
    expect(originOf(store, machineId)).toBe('machine') // fixture self-check

    const settled = settleHumanOutcomeForEntity(store, {
      entity: 'auto-merger',
      value: 1.0,
      answerSource: 'proposal-outcome:implemented',
    })

    expect(settled).toEqual([]) // machine traffic is not a human accept-or-waste signal
    const row = rowOf(store, machineId)
    expect(row.human_outcome).toBeNull()
    expect(row.answer_source).toBeNull()
    store.close()
  })

  it('Q4 POSITIVE CONTROL: settles the human row and skips the machine row in the SAME batch', () => {
    const store = openExperienceStore(':memory:')
    const humanId = logRetrievalExperience(store, {
      queryText: 'did the auto-merger break the build',
      levers: {},
      retrievedChunkIds: [1],
    })
    const machineId = logRetrievalExperience(store, {
      queryText: `${MACHINE_PROMPT} about the auto-merger`,
      levers: {},
      retrievedChunkIds: [1],
    })
    expect(originOf(store, humanId)).toBe('human')
    expect(originOf(store, machineId)).toBe('machine')

    const settled = settleHumanOutcomeForEntity(store, {
      entity: 'auto-merger',
      value: 0.2,
      answerSource: 'proposal-outcome:rejected',
    })

    expect(settled).toEqual([humanId]) // exactly the human row — the machine row is skipped
    expect(rowOf(store, humanId).human_outcome).toBe(0.2)
    expect(rowOf(store, machineId).human_outcome).toBeNull()
    store.close()
  })
})

describe('C1 — FR-034 invariant across every settle path', () => {
  it('leaves NO row with a label but no provenance', () => {
    const store = openExperienceStore(':memory:')
    const a = logRetrievalExperience(store, {
      queryText: 'auto-merger retry budget',
      levers: {},
      retrievedChunkIds: [1],
    })
    const b = logRetrievalExperience(store, {
      queryText: 'why did the build fail',
      levers: {},
      retrievedChunkIds: [1],
    })

    settleHumanOutcomeForEntity(store, {
      entity: 'auto-merger',
      value: 1.0,
      answerSource: 'proposal-outcome:implemented',
    })
    settleHumanOutcomeForAttempt(store, b, 're-asked', 'human-reask:turn-2')

    const orphans = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM retrieval_experience
          WHERE human_outcome IS NOT NULL AND answer_source IS NULL`,
      )
      .get() as { n: number }
    expect(orphans.n).toBe(0)
    expect(rowOf(store, a).answer_source).toBe('proposal-outcome:implemented')
    expect(rowOf(store, b).answer_source).toBe('human-reask:turn-2')
    store.close()
  })

  // T085, relocated. As written the task asserted this in `query-chain.test.ts` — the ONE producer
  // that already stamped provenance before this feature — so it passed whether or not the two
  // genuinely unstamped paths (cli.ts:1352 re-ask, outcome-writer.ts:181 entity) were ever fixed.
  // Asserting it here, over EVERY producer at once, is what makes the gate able to fail.
  it('T085: every settle producer stamps a distinguishable provenance — no orphan labels', () => {
    const store = openExperienceStore(':memory:')
    const mk = (q: string): number =>
      logRetrievalExperience(store, {
        queryText: q,
        levers: {},
        retrievedChunkIds: [1],
        conversationId: 'sess-provenance',
      })

    // 1. chain (derived, deterministic)
    const chainId = mk('how do I restart the SCNS broker safely')
    expect(
      settleChainOutcome(store, {
        experienceId: chainId,
        cue: 'used',
        rule: 'affirmed-advance',
        similarity: 0.08,
        source: 'query-chain:affirmed-advance:turn-4:sim-0.08',
      }),
    ).toBe(true)

    // 2. follow-up reader (derived, model-scored)
    const followupId = mk('what changed in the reward learner')
    expect(
      settleFollowupOutcome(store, {
        experienceId: followupId,
        cue: 're-asked',
        pattern: 'dispute',
        confidence: 0.78,
        nextTurnIndex: 5,
      }),
    ).toBe(true)

    // 3. gate (oracle-verified)
    const gateId = mk('which arm should route this query')
    expect(settleGateAnswered(store, gateId, 'the magma arm', 'transcript-oracle:turn-13')).toBe(
      true,
    )

    // 4. re-ask, exactly as cli.ts:1352 now calls it (deterministic exact match)
    const reaskId = mk('why did the nightly soak fail again')
    expect(
      settleHumanOutcomeForAttempt(store, reaskId, 're-asked', 'human-reask:exact-match'),
    ).toBe(true)

    // 5. entity, exactly as outcome-writer.ts:181 now calls it (delayed, bounded)
    const entityId = mk('the auto-merger keeps reverting my branch')
    expect(
      settleHumanOutcomeForEntity(store, {
        entity: 'auto-merger',
        value: 1.0,
        answerSource: 'proposal-outcome:implemented',
      }),
    ).toEqual([entityId])

    const labelled = store.db
      .prepare(`SELECT COUNT(*) AS n FROM retrieval_experience WHERE human_outcome IS NOT NULL`)
      .get() as { n: number }
    expect(labelled.n).toBe(5) // positive control: all five producers actually wrote a label

    const orphans = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM retrieval_experience
          WHERE human_outcome IS NOT NULL AND answer_source IS NULL`,
      )
      .get() as { n: number }
    expect(orphans.n).toBe(0)

    // Each producer is separably identifiable — a derived label must never read as an oracle one.
    expect(rowOf(store, chainId).answer_source).toMatch(/^query-chain:/)
    expect(rowOf(store, followupId).answer_source).toMatch(/^followup:dispute:turn-5:conf-0\.78$/)
    expect(rowOf(store, gateId).answer_source).toBe('transcript-oracle:turn-13')
    expect(rowOf(store, reaskId).answer_source).toBe('human-reask:exact-match')
    expect(rowOf(store, entityId).answer_source).toBe('proposal-outcome:implemented')
    store.close()
  })
})

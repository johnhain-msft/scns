import { describe, it, expect } from 'vitest'
import {
  HUMAN_OUTCOME_GRADIENT,
  humanOutcomeOfVerdict,
  settleHumanOutcomeForEntity,
} from '../../../src/memory/human-outcome.js'
import {
  openExperienceStore,
  logRetrievalExperience,
} from '../../../src/memory/experience-store.js'

// ── Phase D — the human accept-vs-waste signal on the SAME 6-pt gradient as the App-C.3 judge
// (1.0/0.8/0.6/0.4/0.2/0.0), so human and judge outcomes are directly comparable rows in the
// experience store. The implicit emitting surface is the D2b proposal-outcome verdict.

describe('HUMAN_OUTCOME_GRADIENT — the 6-pt App-C.3-aligned scale', () => {
  it('exposes exactly the six judge-gradient anchor values', () => {
    expect(Object.values(HUMAN_OUTCOME_GRADIENT).sort()).toEqual([0.0, 0.2, 0.4, 0.6, 0.8, 1.0])
  })
})

describe('humanOutcomeOfVerdict — implicit accept-vs-waste from the D2b proposal verdict', () => {
  it('maps landed verdicts to accepted (1.0)', () => {
    expect(humanOutcomeOfVerdict('implemented')).toBe(1.0)
    expect(humanOutcomeOfVerdict('merged')).toBe(1.0)
  })
  it('maps passed-gate to partially-used (0.6 — gate passed, not yet landed by the human)', () => {
    expect(humanOutcomeOfVerdict('passed-gate')).toBe(0.6)
  })
  it('maps rejected to waste (0.2) and reverted to hard waste (0.0 — cost time AND was undone)', () => {
    expect(humanOutcomeOfVerdict('rejected')).toBe(0.2)
    expect(humanOutcomeOfVerdict('reverted')).toBe(0.0)
  })

  // ─── CHANGED BEHAVIOUR — disclosed, not silent ────────────────────────────────────────────
  // Until 2026-08-04 this file asserted `humanOutcomeOfVerdict('failed') === 0.2`, i.e. a build
  // failure was scored as human WASTE. That is the Phase 10f defect in miniature: `failed` says
  // the machine could not build it. It says NOTHING about whether John wanted it. Scoring an
  // unbuilt idea as waste books a verdict he never gave — the same inversion that turned his
  // approval of 65a914f4 into his refusal.
  //
  // A midpoint (0.5) was considered and REJECTED: a midpoint is still a datum, and it would still
  // drag the mean. The honest answer is "no outcome yet", and this function already spells that
  // `null` (see `needs-human` below). `outcome-writer.ts:256` guards `if (value !== null)`, so a
  // null settles nothing rather than settling something false.
  //
  // Ruled by John Hain, 2026-08-04 ("failed gradient → neutral"), resolving §11 of
  // docs/evidence/003-phase-10f-failure-branch-2026-08-04.md, where this change was first
  // proposed by a grader, REFUSED by the implementer for breaking T156, and escalated to him.
  // T156 is retired in test/unit/suggest/verdict-integrity.test.ts with matching disclosure.
  it('returns null for failed and needs-human (no outcome YET — never write a pending as a score)', () => {
    expect(humanOutcomeOfVerdict('failed')).toBeNull()
    expect(humanOutcomeOfVerdict('needs-human')).toBeNull()
  })
})

describe('settleHumanOutcomeForEntity — delayed, bounded, auditable credit assignment (trap #3)', () => {
  it('settles only UNSETTLED rows whose query names the entity, newest-first, capped', () => {
    const store = openExperienceStore(':memory:')
    const mk = (q: string): number =>
      logRetrievalExperience(store, { queryText: q, levers: {}, retrievedChunkIds: [1] })
    const a = mk('auto-merger crash loop')
    const b = mk('why did the auto-merger revert')
    const c = mk('dashboard styling') // different entity — never settled
    const d = mk('auto-merger retry budget')
    const settled = settleHumanOutcomeForEntity(store, {
      entity: 'auto-merger',
      value: 1.0,
      cap: 2,
    })
    expect(settled.sort()).toEqual([b, d].sort()) // newest 2 of the 3 matches; capped
    const outcome = (id: number): number | null =>
      (
        store.db
          .prepare(`SELECT human_outcome AS h FROM retrieval_experience WHERE id = ?`)
          .get(id) as { h: number | null }
      ).h
    expect(outcome(d)).toBe(1.0)
    expect(outcome(b)).toBe(1.0)
    expect(outcome(a)).toBeNull() // beyond the cap
    expect(outcome(c)).toBeNull() // different entity
    store.close()
  })
  it('never overwrites an already-settled outcome (first signal wins; audit trail stays stable)', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, {
      queryText: 'auto-merger x',
      levers: {},
      retrievedChunkIds: [],
    })
    expect(settleHumanOutcomeForEntity(store, { entity: 'auto-merger', value: 1.0 })).toEqual([id])
    expect(settleHumanOutcomeForEntity(store, { entity: 'auto-merger', value: 0.0 })).toEqual([])
    const r = store.db
      .prepare(`SELECT human_outcome AS h FROM retrieval_experience WHERE id = ?`)
      .get(id) as { h: number }
    expect(r.h).toBe(1.0)
    store.close()
  })
  it('returns [] on invalid value or empty entity (fail-safe)', () => {
    const store = openExperienceStore(':memory:')
    logRetrievalExperience(store, { queryText: 'auto-merger x', levers: {}, retrievedChunkIds: [] })
    expect(settleHumanOutcomeForEntity(store, { entity: '', value: 1.0 })).toEqual([])
    expect(settleHumanOutcomeForEntity(store, { entity: 'auto-merger', value: 2 })).toEqual([])
    store.close()
  })
})

// ── T022/T025 [US2] (specs/001-learning-memory-loop) — per-attempt binding + implicit cues ───────
import {
  openExperienceStore,
  logRetrievalExperience,
  settleHumanOutcome,
} from '../../../src/memory/experience-store.js'
import { loadRewardRows } from '../../../src/reward/kto-learner.js'
import {
  humanOutcomeOfCue,
  settleHumanOutcomeForAttempt,
} from '../../../src/memory/human-outcome.js'

describe('T022 — the human verdict binds to the EXACT attempt id (0% topic-only)', () => {
  it('settling one attempt leaves a same-topic sibling untouched (the collision trap)', () => {
    const store = openExperienceStore(':memory:')
    const a = logRetrievalExperience(store, {
      queryText: 'broker port decision',
      levers: {},
      retrievedChunkIds: [1],
    })
    const b = logRetrievalExperience(store, {
      queryText: 'broker port decision', // SAME topic — only per-attempt binding can separate them
      levers: {},
      retrievedChunkIds: [2],
    })
    expect(settleHumanOutcome(store, a, 1.0)).toBe(true)
    const rows = store.db
      .prepare('SELECT id, human_outcome FROM retrieval_experience ORDER BY id')
      .all() as { id: number; human_outcome: number | null }[]
    expect(rows.find((r) => r.id === a)!.human_outcome).toBe(1.0)
    expect(rows.find((r) => r.id === b)!.human_outcome).toBeNull() // sibling NOT settled
    store.close()
  })

  it('FIRST-SIGNAL-WINS: a second settle on the same id is refused and the value stands', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, { queryText: 'q', levers: {}, retrievedChunkIds: [] })
    expect(settleHumanOutcome(store, id, 0.2)).toBe(true)
    expect(settleHumanOutcome(store, id, 1.0)).toBe(false) // refused, not overwritten
    const r = store.db
      .prepare('SELECT human_outcome FROM retrieval_experience WHERE id = ?')
      .get(id) as {
      human_outcome: number
    }
    expect(r.human_outcome).toBe(0.2)
    store.close()
  })

  it('an UNSETTLED attempt (human_outcome IS NULL) never reaches the reward learner', () => {
    const store = openExperienceStore(':memory:')
    const settled = logRetrievalExperience(store, {
      queryText: 'settled',
      levers: { exploreArm: 'hybrid', propensity: 1 },
      retrievedChunkIds: [],
    })
    logRetrievalExperience(store, {
      queryText: 'unsettled',
      levers: { exploreArm: 'hybrid', propensity: 1 },
      retrievedChunkIds: [],
    })
    settleHumanOutcome(store, settled, 0.8)
    const rows = loadRewardRows(store)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.humanOutcome).toBe(0.8)
    store.close()
  })
})

describe('T025 — implicit cues map onto the 6-pt gradient (acceptedEdited finally returned)', () => {
  it('used → accepted 1.0; edited → acceptedEdited 0.8; re-asked → waste 0.2', () => {
    expect(humanOutcomeOfCue('used')).toBe(1.0)
    expect(humanOutcomeOfCue('edited')).toBe(0.8)
    expect(humanOutcomeOfCue('re-asked')).toBe(0.2)
  })

  it('settleHumanOutcomeForAttempt binds a cue to the exact id; first-signal-wins; invalid id fail-safe', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, { queryText: 'q', levers: {}, retrievedChunkIds: [] })
    expect(settleHumanOutcomeForAttempt(store, id, 'edited')).toBe(true)
    const r = store.db
      .prepare('SELECT human_outcome FROM retrieval_experience WHERE id = ?')
      .get(id) as {
      human_outcome: number
    }
    expect(r.human_outcome).toBe(0.8)
    expect(settleHumanOutcomeForAttempt(store, id, 'used')).toBe(false) // first signal stands
    expect(settleHumanOutcomeForAttempt(store, -5, 'used')).toBe(false) // fail-safe
    store.close()
  })
})

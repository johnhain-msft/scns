import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openExperienceStore,
  logRetrievalExperience,
  type ExperienceStore,
} from '../../../src/memory/experience-store.js'
import {
  findChainCandidates,
  findChainOutcome,
  findChainResidue,
  settleChainOutcome,
  settleFollowupOutcome,
} from '../../../src/memory/query-chain.js'
import {
  createSessionTranscript,
  type SessionTranscript,
} from '../../../src/memory/session-transcript.js'

// ── The abstain RESIDUE: what the deterministic rules could not label ─────────────────────────────
//
// The follow-up reader is strictly ADDITIVE. It only ever sees pairs `classifyChainStep` abstained on,
// so every pair the precise rules can settle is still settled by them, on their own provenance, and the
// existing precedence is untouched. These tests pin that boundary in both directions.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeTranscript(sessionId: string, messages: string[]): SessionTranscript {
  const dir = mkdtempSync(join(tmpdir(), 'scns-residue-'))
  dirs.push(dir)
  const path = join(dir, 'session-store.db')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      turn_index INTEGER NOT NULL,
      user_message TEXT,
      timestamp TEXT,
      UNIQUE(session_id, turn_index)
    );`)
  db.prepare('INSERT INTO sessions (id) VALUES (?)').run(sessionId)
  const ins = db.prepare(
    'INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?,?,?,?)',
  )
  messages.forEach((m, i) => ins.run(sessionId, i, m, '2026-07-28T03:00:00.000Z'))
  db.close()
  return createSessionTranscript({ path })
}

const mk = (store: ExperienceStore, conversationId: string, queryText: string): number =>
  logRetrievalExperience(store, {
    queryText,
    levers: { traverse: true, synthesize: true },
    retrievedChunkIds: [1, 2],
    conversationId,
    latencyMs: 400,
  })

const col = <T>(store: ExperienceStore, id: number, name: string): T =>
  (store.db.prepare(`SELECT ${name} AS v FROM retrieval_experience WHERE id = ?`).get(id) as {
    v: T
  }).v

const CONV = 'sess-residue'
// Real abstentions measured on the live store 2026-07-28 (.probe-tmp/ceiling.ts).
const PRIOR_DISPUTED = 'SCNS scheduling: two distinct layers -- the broker task-scheduler and the jobs'
const NEXT_DISPUTE = 'confirm that those tasks never actually run -- pretty sure they do'
const PRIOR_AFFIRMED = 'whaat do you men my next message settles 843 nad 845?'
const NEXT_AFFIRM_TYPO = 'okayu -- so we need to handoff to a new session that can audit aand suggest some fixes?'

describe('findChainCandidates — the single shared eligibility pass', () => {
  it('yields eligible pairs newest-first and excludes machine briefings', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript(CONV, [PRIOR_DISPUTED, NEXT_DISPUTE, PRIOR_AFFIRMED, NEXT_AFFIRM_TYPO])
    const a = mk(store, CONV, PRIOR_DISPUTED)
    const b = mk(store, CONV, PRIOR_AFFIRMED)
    // a sub-agent brief in the same conversation is NOT a transcript turn ⇒ never eligible
    const machine = mk(store, CONV, 'You are an INDEPENDENT fresh-context grader (producer != grader).')
    const got = findChainCandidates(store, { conversationId: CONV, transcript })
    expect(got.map((c) => c.experienceId)).toEqual([b, a])
    expect(got.map((c) => c.experienceId)).not.toContain(machine)
    expect(got[0]?.nextTurn).toBe(NEXT_AFFIRM_TYPO)
    transcript.close()
    store.close()
  })
})

describe('findChainResidue — exactly the pairs the deterministic rules abstained on', () => {
  it('POSITIVE: returns the pair the regexes could not label (the typo-defeated affirmation)', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript(CONV, [PRIOR_AFFIRMED, NEXT_AFFIRM_TYPO])
    const id = mk(store, CONV, PRIOR_AFFIRMED)
    // pinned: `/^(ok|okay)\b/` does not match "okayu", so the deterministic classifier abstains
    expect(findChainOutcome(store, { conversationId: CONV, transcript })).toBeNull()
    const residue = findChainResidue(store, { conversationId: CONV, transcript })
    expect(residue?.experienceId).toBe(id)
    expect(residue?.nextTurn).toBe(NEXT_AFFIRM_TYPO)
    transcript.close()
    store.close()
  })

  it('NEGATIVE: a pair the deterministic rules CAN label is never offered to the reader', () => {
    const store = openExperienceStore(':memory:')
    const prior = 'restart the scns broker safely without losing scheduler state'
    const transcript = makeTranscript(CONV, [prior, `${prior} please`])
    const id = mk(store, CONV, prior)
    // a near-verbatim reformulation is the deterministic reformulation rule's own case
    expect(findChainOutcome(store, { conversationId: CONV, transcript })?.experienceId).toBe(id)
    expect(findChainResidue(store, { conversationId: CONV, transcript })).toBeNull()
    transcript.close()
    store.close()
  })

  it('NEGATIVE: no transcript oracle ⇒ no residue (a chain needs real human turns)', () => {
    const store = openExperienceStore(':memory:')
    mk(store, CONV, PRIOR_AFFIRMED)
    expect(findChainResidue(store, { conversationId: CONV, transcript: null })).toBeNull()
    expect(findChainResidue(store, { conversationId: undefined, transcript: null })).toBeNull()
    store.close()
  })

  it('NEGATIVE: an already-settled row is never re-offered', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript(CONV, [PRIOR_DISPUTED, NEXT_DISPUTE])
    const id = mk(store, CONV, PRIOR_DISPUTED)
    expect(findChainResidue(store, { conversationId: CONV, transcript })?.experienceId).toBe(id)
    settleFollowupOutcome(store, {
      experienceId: id,
      cue: 're-asked',
      pattern: 'dispute',
      confidence: 0.78,
      nextTurnIndex: 1,
    })
    expect(findChainResidue(store, { conversationId: CONV, transcript })).toBeNull()
    transcript.close()
    store.close()
  })
})

describe('settleFollowupOutcome — the shared seam + distinguishable provenance', () => {
  it('writes the cue through the existing gradient and stamps followup: provenance + confidence', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, CONV, PRIOR_DISPUTED)
    expect(
      settleFollowupOutcome(store, {
        experienceId: id,
        cue: 're-asked',
        pattern: 'dispute',
        confidence: 0.78,
        nextTurnIndex: 5,
      }),
    ).toBe(true)
    expect(col<number>(store, id, 'human_outcome')).toBe(0.2)
    expect(col<string>(store, id, 'answer_source')).toBe('followup:dispute:turn-5:conf-0.78')
    store.close()
  })

  it('maps its cues onto the SAME gradient the other producers use, and REFUSES an accept', () => {
    const store = openExperienceStore(':memory:')
    const edited = mk(store, CONV, 'q1')
    const smuggled = mk(store, CONV, 'q2')
    expect(
      settleFollowupOutcome(store, {
        experienceId: edited,
        cue: 'edited',
        pattern: 'correct-and-continue',
        confidence: 0.75,
        nextTurnIndex: 2,
      }),
    ).toBe(true)
    expect(col<number>(store, edited, 'human_outcome')).toBe(0.8)

    // The seam must refuse an ACCEPT at RUNTIME, not merely at compile time -- an exported function
    // reached through `as any` is exactly how a type-only guard gets bypassed.
    expect(
      settleFollowupOutcome(store, {
        experienceId: smuggled,
        cue: 'used' as unknown as 'edited',
        pattern: 'acknowledge-advance',
        confidence: 0.9,
        nextTurnIndex: 1,
      }),
    ).toBe(false)
    expect(col<number | null>(store, smuggled, 'human_outcome')).toBeNull()
    store.close()
  })

  it('PRECEDENCE: first-signal-wins — it can never overwrite an oracle-grade or deterministic label', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, CONV, PRIOR_DISPUTED)
    // the deterministic producer reaches the row first (it runs synchronously on the briefing path)
    expect(
      settleChainOutcome(store, {
        experienceId: id,
        cue: 'used',
        rule: 'affirmed-advance',
        similarity: 0.2,
        source: 'query-chain:affirmed-advance:turn-4:sim-0.20',
      }),
    ).toBe(true)
    // the reader, running later, is refused and annotates nothing
    expect(
      settleFollowupOutcome(store, {
        experienceId: id,
        cue: 're-asked',
        pattern: 'dispute',
        confidence: 0.99,
        nextTurnIndex: 5,
      }),
    ).toBe(false)
    expect(col<number>(store, id, 'human_outcome')).toBe(1.0)
    expect(col<string>(store, id, 'answer_source')).toBe('query-chain:affirmed-advance:turn-4:sim-0.20')
    store.close()
  })
})

// ── Reachability: an abstain must not seal off the rest of the conversation ───────────────────────
//
// `findChainResidue` returns the NEWEST unlabelled eligible pair. That is right for the live briefing
// hook, which gets another chance on the next briefing — but the cross-conversation sweep gets no
// second chance: the reader abstains, the row stays NULL, and every OLDER eligible pair in that
// conversation becomes permanently unreachable.
//
// Measured read-only over a copy of the live corpus 2026-07-31:
//   TOTAL ELIGIBLE PAIRS (the ceiling): 41 {"magma":36,"multihop-iter":5}
//   RESIDUE (reachable, newest-per-conversation): 17 {"magma":16,"multihop-iter":1}
// So 4 of the challenger arm's 5 eligible pairs were unreachable for no reason other than position.
describe('findChainResidue — excludeIds lets a caller advance past an abstained pair', () => {
  it('POSITIVE: returns the NEXT eligible pair once the newest is excluded', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript(CONV, [
      PRIOR_DISPUTED,
      NEXT_DISPUTE,
      PRIOR_AFFIRMED,
      NEXT_AFFIRM_TYPO,
    ])
    const older = mk(store, CONV, PRIOR_DISPUTED)
    const newer = mk(store, CONV, PRIOR_AFFIRMED)

    const first = findChainResidue(store, { conversationId: CONV, transcript })
    expect(first?.experienceId).toBe(newer)

    // the reader abstained on `newer`, so it is still NULL — without excludeIds it is returned forever
    expect(findChainResidue(store, { conversationId: CONV, transcript })?.experienceId).toBe(newer)

    const second = findChainResidue(store, {
      conversationId: CONV,
      transcript,
      excludeIds: new Set([newer]),
    })
    expect(second?.experienceId).toBe(older)
    expect(second?.nextTurn).toBe(NEXT_DISPUTE)
    transcript.close()
    store.close()
  })

  it('NEGATIVE: excluding every eligible pair yields null, never a recycled one', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript(CONV, [
      PRIOR_DISPUTED,
      NEXT_DISPUTE,
      PRIOR_AFFIRMED,
      NEXT_AFFIRM_TYPO,
    ])
    const older = mk(store, CONV, PRIOR_DISPUTED)
    const newer = mk(store, CONV, PRIOR_AFFIRMED)
    expect(
      findChainResidue(store, {
        conversationId: CONV,
        transcript,
        excludeIds: new Set([newer, older]),
      }),
    ).toBeNull()
    transcript.close()
    store.close()
  })

  it('NEGATIVE: excludeIds cannot promote an INELIGIBLE pair — the gates still hold', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript(CONV, [PRIOR_AFFIRMED, NEXT_AFFIRM_TYPO])
    const eligible = mk(store, CONV, PRIOR_AFFIRMED)
    // never delivered ⇒ never eligible, with or without excludeIds
    const undelivered = logRetrievalExperience(store, {
      queryText: PRIOR_AFFIRMED,
      levers: { traverse: true, synthesize: true },
      retrievedChunkIds: [1],
      conversationId: CONV,
      latencyMs: 99_000,
    })
    expect(
      findChainResidue(store, {
        conversationId: CONV,
        transcript,
        excludeIds: new Set([eligible]),
      }),
    ).toBeNull()
    expect(undelivered).toBeGreaterThan(0)
    transcript.close()
    store.close()
  })
})

// ── The prior must be a HUMAN need, not a machine brief ──────────────────────────────────────────
//
// `readFollowupSatisfaction` already refuses a machine-authored NEXT turn, on the grounds that it is
// not the human's reaction. The same argument applies to the PRIOR with equal force: if no human
// asked, there is no human need for the briefing to have served, so any accept/waste label derived
// from that pair is meaningless. That asymmetry is the contamination class that already produced
// fabricated live ACCEPTs — and cleaning the rows afterwards left the producer that admits them
// unfixed on this path.
//
// It is not hypothetical: a machine prompt lands in the transcript verbatim when a brief is pasted
// into the prompt slot, so the transcript match does NOT screen it out. Measured on a copy of the
// live corpus 2026-07-31, 3 of the 40 reachable residue pairs had machine-authored priors.
describe('findChainCandidates — a machine-authored prior is never a labellable need', () => {
  const MACHINE_PRIOR =
    'You are picking up Lane B (agent harness / ops) on the Morning Pod repo at /tmp/x (branch main).'
  const HUMAN_NEXT = 'what is recommendation? sounds lke theres some bugs to fix/pass back to the dev?'

  it('NEGATIVE: excludes a machine-authored prior even when it IS in the transcript', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript(CONV, [MACHINE_PRIOR, HUMAN_NEXT])
    const machine = mk(store, CONV, MACHINE_PRIOR)
    expect(findChainCandidates(store, { conversationId: CONV, transcript })).toEqual([])
    expect(findChainResidue(store, { conversationId: CONV, transcript })).toBeNull()
    expect(machine).toBeGreaterThan(0)
    transcript.close()
    store.close()
  })

  it('POSITIVE: a human prior in the same shape is still eligible', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript(CONV, [PRIOR_AFFIRMED, HUMAN_NEXT])
    const id = mk(store, CONV, PRIOR_AFFIRMED)
    expect(
      findChainCandidates(store, { conversationId: CONV, transcript }).map((c) => c.experienceId),
    ).toEqual([id])
    transcript.close()
    store.close()
  })
})

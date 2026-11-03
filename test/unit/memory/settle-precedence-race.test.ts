/**
 * C8 (specs/003-label-integrity-defects, edge case "two producers race for the same record") —
 * first-signal-wins must favour the HIGHER-PROVENANCE signal.
 *
 * First-signal-wins is purely TEMPORAL: `settleHumanOutcome`'s `WHERE human_outcome IS NULL` gives a
 * correct atomic no-lost-update, but it has no idea which producer is better. The ordering that makes
 * the oracle win is therefore NOT in the SQL — it lives in two places, and neither had a test:
 *
 *  1. The synchronous call ORDER in `cli.ts` (re-ask → gate → chain → follow-up reader last).
 *  2. `hasPendingGateQuestion`, which stops a derived reader pre-empting an answer still in flight.
 *
 * Guard 2 has a TOCTOU hole. `findChainResidue` evaluates it, but the follow-up reader then `await`s
 * an ACP round-trip before settling (`cli.ts` ~1394–1410) — so a clarifying question DELIVERED during
 * that await is invisible, and the derived label lands on a row that was waiting for the human. The
 * oracle answer then arrives and is REFUSED, permanently, because the row is no longer NULL.
 */
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  openExperienceStore,
  logRetrievalExperience,
  settleHumanOutcome,
  type ExperienceStore,
} from '../../../src/memory/experience-store.js'
import {
  findChainOutcome,
  findChainResidue,
  settleChainOutcome,
  settleFollowupOutcome,
} from '../../../src/memory/query-chain.js'
import {
  createSessionTranscript,
  type SessionTranscript,
} from '../../../src/memory/session-transcript.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const CONV = 'sess-race'
const PRIOR = 'SCNS scheduling: two distinct layers -- the broker task-scheduler and the jobs'
const NEXT = 'confirm that those tasks never actually run -- pretty sure they do'

function makeTranscript(messages: string[]): SessionTranscript {
  const dir = mkdtempSync(join(tmpdir(), 'scns-race-'))
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
  db.prepare('INSERT INTO sessions (id) VALUES (?)').run(CONV)
  const ins = db.prepare(
    'INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?,?,?,?)',
  )
  messages.forEach((m, i) => ins.run(CONV, i, m, '2026-08-02T03:00:00.000Z'))
  db.close()
  return createSessionTranscript({ path })
}

const mk = (store: ExperienceStore, queryText: string): number =>
  logRetrievalExperience(store, {
    queryText,
    levers: { traverse: true, synthesize: true },
    retrievedChunkIds: [1, 2],
    conversationId: CONV,
    latencyMs: 400,
  })

const col = <T>(store: ExperienceStore, id: number, name: string): T =>
  (
    store.db.prepare(`SELECT ${name} AS v FROM retrieval_experience WHERE id = ?`).get(id) as {
      v: T
    }
  ).v

const followup = (store: ExperienceStore, id: number): boolean =>
  settleFollowupOutcome(store, {
    experienceId: id,
    cue: 're-asked',
    pattern: 'dispute',
    confidence: 0.9,
    nextTurnIndex: 1,
  })

describe('C8 [US2] settle precedence — the derived reader must never pre-empt the oracle', () => {
  it('REFUSES a derived settle when a clarifying question was delivered DURING the await', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript([PRIOR, NEXT])
    const id = mk(store, PRIOR)

    // T0 — the reader picks its candidate. No question outstanding, so the guard lets it through.
    const residue = findChainResidue(store, { conversationId: CONV, transcript })
    expect(residue?.experienceId).toBe(id)

    // T1 — the await window. A clarifying question is delivered to the human and is now outstanding.
    // In production this is `markGateDelivered` firing on the very next briefing (cli.ts ~1424).
    store.db
      .prepare(`UPDATE retrieval_experience SET gate_question = ? WHERE id = ?`)
      .run('Which scheduler did you mean — broker or jobs?', id)

    // T2 — the ACP read returns and the reader settles. It MUST refuse: an oracle-grade answer to a
    // question the human can see is in flight, and a derived label here blocks it forever.
    expect(followup(store, id)).toBe(false)
    expect(col<number | null>(store, id, 'human_outcome')).toBeNull()

    // …and the oracle answer that arrives next still lands, with ITS provenance.
    expect(settleHumanOutcome(store, id, 1.0, 'transcript-oracle:turn-3')).toBe(true)
    expect(col<number>(store, id, 'human_outcome')).toBe(1)
    expect(col<string>(store, id, 'answer_source')).toBe('transcript-oracle:turn-3')

    transcript.close()
    store.close()
  })

  it('NEGATIVE CONTROL: with no question outstanding the derived settle still lands', () => {
    // Without this the fix could be "always refuse", which would silently delete the whole
    // follow-up-reader signal while turning the test above green.
    const store = openExperienceStore(':memory:')
    const id = mk(store, PRIOR)

    expect(followup(store, id)).toBe(true)
    expect(col<number>(store, id, 'human_outcome')).toBe(0.2)
    expect(col<string>(store, id, 'answer_source')).toMatch(/^followup:/)

    store.close()
  })

  it('NEGATIVE CONTROL: an ALREADY-ANSWERED question does not block the derived settle', () => {
    // DP-F2 (judge, 2026-08-02): this control was previously a NO-OP. `logRetrievalExperience`'s
    // INSERT column list (`experience-store.ts:360-366`) does not include `gate_question`, so the
    // column was ALREADY null and the `UPDATE … SET gate_question = NULL` cleared nothing — making
    // this a byte-for-byte duplicate of the control above it. It could not distinguish "asked and
    // answered" from "never asked", which is the only thing its name claims. The transition is now
    // real: the question is SET, then cleared, so the guard is observed flipping back.
    const store = openExperienceStore(':memory:')
    const id = mk(store, PRIOR)

    store.db
      .prepare(`UPDATE retrieval_experience SET gate_question = ? WHERE id = ?`)
      .run('Which scheduler did you mean — broker or jobs?', id)
    // Precondition: the guard is genuinely engaged before we clear it, otherwise this proves nothing.
    expect(col<string | null>(store, id, 'gate_question')).not.toBeNull()
    expect(followup(store, id)).toBe(false)

    // The human answers; the question is cleared. The reader is free again.
    store.db.prepare(`UPDATE retrieval_experience SET gate_question = NULL WHERE id = ?`).run(id)
    expect(followup(store, id)).toBe(true)
    store.close()
  })

  it('an oracle label already on the row is never overwritten, value OR provenance', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, PRIOR)

    expect(settleHumanOutcome(store, id, 1.0, 'transcript-oracle:turn-3')).toBe(true)
    expect(followup(store, id)).toBe(false)

    expect(col<number>(store, id, 'human_outcome')).toBe(1)
    // The provenance must survive too: a derived source overwriting an oracle one would make the
    // label unauditable even though its VALUE was right.
    expect(col<string>(store, id, 'answer_source')).toBe('transcript-oracle:turn-3')
    store.close()
  })
})

/**
 * DP-F1 (adversarial judge, 2026-08-02) — C8 was only HALF fixed.
 *
 * `hasPendingGateQuestion` was applied in `findChainResidue` (the ACP-reader path) and in
 * `settleFollowupOutcome`, but NOT in `findChainCandidates` — the ONE shared eligibility pass that
 * every derived producer consumes. `findChainOutcome` walks the same candidates and had no guard at
 * all, so the deterministic `query-chain:` producer would settle a row holding a DELIVERED, unanswered
 * clarifying question. Because `settleHumanOutcome` is first-signal-wins, the human's real answer is
 * then refused PERMANENTLY and `elicited_intent` is lost.
 *
 * The "synchronous call order in cli.ts protects us" argument does not cover this: `runSettleSweep`
 * (`cli.ts:1876` → `settle-sweep.ts:131`) walks up to 5000 unsettled conversations running ONLY the
 * derived producers — `settleGateAnswered` is not reachable from `settle-sweep.ts` at all.
 *
 * Live exposure when this was found (read-only, isolated copy): rows 843, 2068 and 2072 were
 * delivered-unanswered, unsettled, on arm `magma`, inside the 1500 ms delivery gate — and 2068/2072
 * appeared DURING the triage session, so the exposed set grows with live traffic.
 *
 * The fix hoists the guard into `findChainCandidates` so BOTH producers inherit it.
 */
describe('DP-F1 [US2] the guard lives in the SHARED eligibility pass, not one caller', () => {
  // A near-restatement, so `classifyChainStep` returns a `reformulation` verdict rather than
  // abstaining — this is the path `findChainResidue` deliberately does NOT see.
  const REPHRASE = 'SCNS scheduling -- the two distinct layers, broker task-scheduler and the jobs'

  it('findChainOutcome REFUSES a row holding a delivered, unanswered clarifying question', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript([PRIOR, REPHRASE])
    const id = mk(store, PRIOR)

    // Precondition: without a question outstanding this pair IS classifiable, so a null result below
    // means the guard fired — not that the fixture simply fails to classify.
    expect(findChainOutcome(store, { conversationId: CONV, transcript })?.experienceId).toBe(id)

    store.db
      .prepare(`UPDATE retrieval_experience SET gate_question = ?, gate_delivered = 1 WHERE id = ?`)
      .run('Which scheduler did you mean — broker or jobs?', id)

    expect(findChainOutcome(store, { conversationId: CONV, transcript })).toBeNull()

    transcript.close()
    store.close()
  })

  it('settleChainOutcome cannot land a derived label while the oracle answer is in flight', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript([PRIOR, REPHRASE])
    const id = mk(store, PRIOR)

    const outcome = findChainOutcome(store, { conversationId: CONV, transcript })
    expect(outcome?.experienceId).toBe(id)

    // The question is delivered before the sweep settles — exactly the live state of rows 843/2068/2072.
    store.db
      .prepare(`UPDATE retrieval_experience SET gate_question = ?, gate_delivered = 1 WHERE id = ?`)
      .run('Which scheduler did you mean — broker or jobs?', id)

    // Re-selection through the shared pass must now yield nothing to settle.
    expect(findChainOutcome(store, { conversationId: CONV, transcript })).toBeNull()
    expect(col<number | null>(store, id, 'human_outcome')).toBeNull()

    // …and the oracle answer that arrives next still lands, with ITS provenance and intent intact.
    expect(settleHumanOutcome(store, id, 1.0, 'transcript-oracle:turn-3')).toBe(true)
    expect(col<number>(store, id, 'human_outcome')).toBe(1)
    expect(col<string>(store, id, 'answer_source')).toBe('transcript-oracle:turn-3')

    transcript.close()
    store.close()
  })

  it('NEGATIVE CONTROL: with no question outstanding the chain producer still settles', () => {
    // Without this, "always refuse" would turn both tests above green while deleting the entire
    // deterministic producer — the higher-provenance signal C8 exists to protect.
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript([PRIOR, REPHRASE])
    const id = mk(store, PRIOR)

    const outcome = findChainOutcome(store, { conversationId: CONV, transcript })
    expect(outcome).not.toBeNull()
    expect(settleChainOutcome(store, outcome!)).toBe(true)
    expect(col<number>(store, id, 'human_outcome')).toBe(0.2)
    expect(col<string>(store, id, 'answer_source')).toMatch(/^query-chain:/)

    transcript.close()
    store.close()
  })

  it('NEGATIVE CONTROL: an ANSWERED question (cleared) frees the chain producer again', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript([PRIOR, REPHRASE])
    const id = mk(store, PRIOR)

    store.db
      .prepare(`UPDATE retrieval_experience SET gate_question = ?, gate_delivered = 1 WHERE id = ?`)
      .run('Which scheduler did you mean — broker or jobs?', id)
    expect(findChainOutcome(store, { conversationId: CONV, transcript })).toBeNull()

    store.db.prepare(`UPDATE retrieval_experience SET gate_question = NULL WHERE id = ?`).run(id)
    expect(findChainOutcome(store, { conversationId: CONV, transcript })?.experienceId).toBe(id)

    transcript.close()
    store.close()
  })

  it('findChainResidue still refuses too — the ACP path must not regress', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript([PRIOR, NEXT])
    const id = mk(store, PRIOR)

    expect(findChainResidue(store, { conversationId: CONV, transcript })?.experienceId).toBe(id)

    store.db
      .prepare(`UPDATE retrieval_experience SET gate_question = ?, gate_delivered = 1 WHERE id = ?`)
      .run('Which scheduler did you mean — broker or jobs?', id)

    expect(findChainResidue(store, { conversationId: CONV, transcript })).toBeNull()

    transcript.close()
    store.close()
  })
})

describe('C8 [US2] producer ORDER in cli.ts — the mechanism that makes the oracle first', () => {
  // The precedence is a SOURCE-ORDER property, so no behavioural test can catch it being reordered.
  // Nothing else in the suite fails if the follow-up reader is moved above the oracle producers, and
  // the result would be a silent, permanent downgrade of every contested label's provenance.
  // Comments are STRIPPED first. `cli.ts` documents this precedence in prose right next to the code,
  // so an un-stripped scan would match the explanation instead of the call — and a future comment
  // naming a producer earlier in the file would mask a genuine reorder behind a passing test.
  const src = readFileSync(new URL('../../../src/cli.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  const at = (needle: string): number => {
    const first = src.indexOf(needle)
    expect(first, `producer call site not found in cli.ts: ${needle}`).toBeGreaterThan(-1)
    // Exactly one call site: a second one would make `indexOf` ambiguous and could hide a reorder.
    expect(src.indexOf(needle, first + 1), `expected exactly one ${needle} in cli.ts`).toBe(-1)
    return first
  }

  it('runs the DERIVED follow-up reader after every oracle-grade producer', () => {
    const reask = at('settleHumanOutcomeForAttempt(')
    const gate = at('settleGateAnswered(')
    const chain = at('settleChainOutcome(')
    const derived = at('findChainResidue(')

    expect(derived).toBeGreaterThan(reask)
    expect(derived).toBeGreaterThan(gate)
    expect(derived).toBeGreaterThan(chain)
  })
})

/**
 * RED tests for the approval-rationale gap (feature 003).
 *
 * John's words when he APPROVES a proposal never reach the persistent learning corpus
 * (`proposal_outcomes`), and are erased from the suggestion file on the next status
 * transition. His REJECTION words do land — that asymmetry is the defect.
 *
 * Every test here runs against an isolated store dir + a temp SQLite file. Nothing
 * touches `~/.scns`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
import { recordWeeklyVerdict } from '../../../src/suggest/weekly-session.js'
import { recordSuggestionOutcome } from '../../../src/suggest/outcome-writer.js'
import { createReviewWorkflow } from '../../../src/suggest/review.js'
import { isHumanReason } from '../../../src/suggest/review-reason.js'
import { readDecisionRationales, ingestDecisionRationales } from '../../../src/memory/decision-rationale.js'
import { createVault } from '../../../src/memory/vault.js'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { SuggestionType, type Suggestion } from '../../../src/suggest/types.js'
import type Database from 'better-sqlite3'

let dir: string
let store: ReturnType<typeof createSuggestionStore>
let vault: ReturnType<typeof createVault>
let db: Database.Database

/** A memory-path self-improvement proposal — the only kind the outcome writer tracks. */
function sugg(id: string, o: Partial<Suggestion> = {}): Suggestion {
  return {
    id,
    type: SuggestionType.Workflow,
    title: `title ${id}`,
    description: 'a description',
    confidence: 0.5,
    status: 'pending',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    evidence: [],
    tags: ['self-improvement', 'scns-self-improvement', 'broker', 'broker-port-precedence'],
    ...o,
  } as Suggestion
}

/** The words John actually types at the weekly review. */
const JOHN_APPROVES = 'this unblocks the weekly loop, do it first'
const JOHN_REJECTS = 'wrong layer, the broker already owns this'

function rationalesFor(id: string): Array<string | null> {
  const rows = db
    .prepare('SELECT rationale FROM proposal_outcomes WHERE suggestion_id = ?')
    .all(id) as Array<{ rationale: string | null }>
  return rows.map((r) => r.rationale)
}

/** Verdicts recorded in `proposal_outcomes` for a suggestion, oldest first. */
function outcomeVerdictsFor(id: string): string[] {
  const rows = db
    .prepare('SELECT verdict FROM proposal_outcomes WHERE suggestion_id = ? ORDER BY id ASC')
    .all(id) as Array<{ verdict: string }>
  return rows.map((r) => r.verdict)
}

/**
 * Human-authored rationales for a suggestion, read from the corpus FR-046b specifies.
 *
 * Queried as raw SQL rather than through a module import on purpose: the module does not exist yet,
 * and an unresolvable import would fail collection for the whole file, taking the positive control
 * down with it. A missing table is the red signal we want — visible, and scoped to this assertion.
 */
function humanRationalesFor(id: string): string[] {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_rationale'")
    .get() as { name?: string } | undefined
  if (!exists?.name) return []
  const rows = db
    .prepare(
      "SELECT text FROM decision_rationale WHERE suggestion_id = ? AND author = 'human' ORDER BY id ASC",
    )
    .all(id) as Array<{ text: string }>
  return rows.map((r) => r.text)
}

/**
 * The MARKDOWN surface, read the way production actually stores it from the CLI (FR-053a): the
 * review CLI is handed a vault and no db, so asserting on rows here would assert a configuration
 * production never runs. Ingested via the broker sweep into a scratch db so the assertion goes
 * through the real parser rather than a substring match on the file.
 */
function vaultRationalesFor(id: string): string[] {
  const scratch = openMemoryDb(join(dir, `ingest-${randomUUID()}.db`))
  try {
    ingestDecisionRationales({ db: scratch, vault })
    return readDecisionRationales(scratch, { suggestionId: id, author: 'human' }).map((r) => r.text)
  } finally {
    closeMemoryDb(scratch)
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-approval-rationale-'))
  store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
  vault = createVault({ rootDir: join(dir, 'vault') })
  db = openMemoryDb(join(dir, 'vault.db'))
})

/**
 * The capture dependencies, INJECTED (T129).
 *
 * The original version of this file called `recordWeeklyVerdict(store, id, reply)` and then asserted
 * that rows appeared in `db` — a db the function was never handed. That made the case unsatisfiable
 * by any correct implementation, the same class of error as the option-A assertion corrected in
 * d4e18f4: a red test that pins an impossible contract still gets treated as the specification.
 *
 * Both surfaces are supplied here because this is a single in-process test. PRODUCTION SPLITS THEM
 * (FR-053a) — the review CLI gets `vault` only, and the broker writes rows — and that split is
 * asserted separately below so this convenience cannot quietly become the assumed architecture.
 */
function deps() {
  return { vault, db }
}

afterEach(() => {
  closeMemoryDb(db)
  rmSync(dir, { recursive: true, force: true })
})

describe('approval rationale reaches the learner', () => {
  it('CONTROL: a REJECTION with words lands John rationale in proposal_outcomes', () => {
    const id = randomUUID()
    store.save(sugg(id))

    const res = recordWeeklyVerdict(store, id, { verdict: 'reject', text: JOHN_REJECTS }, deps())
    expect(res.ok).toBe(true)

    const rejected = store.get(id)!
    expect(rejected.status).toBe('rejected')
    expect(rejected.reviewReason).toContain(JOHN_REJECTS)

    const out = recordSuggestionOutcome({ db }, rejected, rejected.status)
    expect(out.recorded).toBe(true)
    expect(rationalesFor(id)).toEqual([expect.stringContaining(JOHN_REJECTS)])
  })

  it('an APPROVAL with words is readable from the rationale corpus at approval time', () => {
    const id = randomUUID()
    store.save(sugg(id))

    const res = recordWeeklyVerdict(store, id, { verdict: 'approve', text: JOHN_APPROVES }, deps())
    expect(res.ok).toBe(true)

    const approved = store.get(id)!
    expect(approved.status).toBe('approved')
    // The words DO reach disk today — that half works.
    expect(approved.reviewReason).toContain(JOHN_APPROVES)

    // FR-045/FR-046b: they must also be readable from the durable rationale corpus, at the moment of
    // the decision, without waiting for the proposal to be implemented and whether or not it ever is.
    expect(humanRationalesFor(id)).toEqual([expect.stringContaining(JOHN_APPROVES)])

    // FR-049a NEGATIVE CONTROL, and the reason this is NOT the disqualified option A: capturing the
    // rationale must NOT write a proposal_outcomes row. `proposal_outcomes` is
    // UNIQUE(suggestion_id, entity, family) ON CONFLICT DO NOTHING, so a row banked here would make
    // the LATER terminal outcome a silent no-op.
    expect(outcomeVerdictsFor(id)).toEqual([])
  })

  it('a later status transition does NOT erase John approval rationale', () => {
    const id = randomUUID()
    store.save(sugg(id))
    recordWeeklyVerdict(store, id, { verdict: 'approve', text: JOHN_APPROVES }, deps())
    expect(store.get(id)!.reviewReason).toContain(JOHN_APPROVES)

    // agent-loop.ts marks the item implemented with NO reason argument.
    store.updateStatus(id, 'implemented')

    const implemented = store.get(id)!
    expect(implemented.status).toBe('implemented')
    expect(implemented.reviewReason).toContain(JOHN_APPROVES)
  })

  it('a machine reason does NOT overwrite John approval rationale', () => {
    const id = randomUUID()
    store.save(sugg(id))
    recordWeeklyVerdict(store, id, { verdict: 'approve', text: JOHN_APPROVES }, deps())

    // quality-gate-arbiter.ts:1098 passes its own machine reason.
    store.updateStatus(id, 'implemented', 'qg-pass')

    const implemented = store.get(id)!
    // The machine verdict may be recorded, but John words must survive somewhere readable.
    expect(implemented.reviewReason).toContain(JOHN_APPROVES)
  })

  it('rationale capture does NOT consume the idempotency slot the terminal outcome needs', () => {
    // Guards against re-introducing the disqualified option A. `proposal_outcomes` is
    // UNIQUE(suggestion_id, entity, family) with ON CONFLICT DO NOTHING (first write wins), so if an
    // approval ever banks a row, the implemented/failed row that follows is silently dropped and the
    // learner never learns whether the approved proposal actually landed. Measured, not assumed:
    //   1st write -> implemented | rationale: human words
    //   2nd write -> implemented | rationale: human words   (the attempted verdict was 'failed')
    //   ROWS STORED: [{"verdict":"implemented","rationale":"human words"}]
    const id = randomUUID()
    store.save(sugg(id))
    recordWeeklyVerdict(store, id, { verdict: 'approve', text: JOHN_APPROVES }, deps())

    // FR-049b: `approved` stays non-terminal for OUTCOME purposes. This is required behaviour, not a
    // defect — the rationale reaches the learner by its own record, not by an outcome row.
    const approved = store.get(id)!
    const atApproval = recordSuggestionOutcome({ db }, approved, approved.status)
    expect(atApproval).toEqual({ recorded: false, skipReason: 'non-terminal-status' })
    expect(outcomeVerdictsFor(id)).toEqual([])

    // ...and the human's words are captured anyway.
    expect(humanRationalesFor(id)).toEqual([expect.stringContaining(JOHN_APPROVES)])

    // The later terminal outcome therefore still lands, in full.
    store.updateStatus(id, 'implemented', 'qg-pass')
    const implemented = store.get(id)!
    const out = recordSuggestionOutcome({ db }, implemented, implemented.status)
    expect(out.recorded).toBe(true)
    expect(outcomeVerdictsFor(id)).toEqual(['implemented'])
  })

  it('a decision recorded WITHOUT a reason produces NO rationale record', () => {
    // FR-051 / SC-025 negative control: absence is representable and is never filled by inference,
    // a default, or an empty placeholder. `defer` is a non-decision and carries no verdict.
    //
    // HONESTY NOTE: this passes VACUOUSLY today — nothing writes rationales yet, so every query
    // returns []. It is not evidence of anything until capture exists. It is here as a standing
    // invariant that must hold before AND after the fix; T135's mutation check is the negative
    // control that can actually fail.
    const id = randomUUID()
    store.save(sugg(id))

    recordWeeklyVerdict(store, id, { verdict: 'defer' } as never, deps())

    expect(humanRationalesFor(id)).toEqual([])
    expect(outcomeVerdictsFor(id)).toEqual([])
  })
})

describe('T128b — the OTHER human seam: `scns review approve|reject`', () => {
  // The weekly session is not the only place John's reasoning arrives. `scns review approve <id>
  // --reason "..."` is a first-class human decision, and it feeds the SAME auto-execute path that
  // erased his words (review.ts:98 transitions to `implemented` with no reason). Capturing only in
  // the weekly session would leave this seam silently lossy, and it is the one he reaches for when
  // he acts on something mid-week rather than waiting for Monday.
  function workflow(vaultDep?: typeof vault) {
    const executor = {
      generatePlan: () => ({ steps: [] }),
      canAutoExecute: () => false,
    } as never
    return createReviewWorkflow({ store, executor, vault: vaultDep })
  }

  it('captures his approval reasoning verbatim', () => {
    const id = randomUUID()
    store.save(sugg(id))

    const res = workflow(vault).approve(id, `human:unblocks-loop:${JOHN_APPROVES}`)

    expect(res.success).toBe(true)
    expect(vaultRationalesFor(id)).toEqual([expect.stringContaining(JOHN_APPROVES)])
  })

  it('captures his rejection reasoning verbatim', () => {
    const id = randomUUID()
    store.save(sugg(id))

    workflow(vault).reject(id, `human:wrong-target:${JOHN_REJECTS}`)

    expect(vaultRationalesFor(id)).toEqual([expect.stringContaining(JOHN_REJECTS)])
  })

  it('does NOT capture a machine reason as if it were his', () => {
    // FR-048: the corpus is a record of HUMAN intent. The auto-execute path calls the same
    // `updateStatus`, and a machine reason arriving here must never be filed under `author: human`
    // — that would train the learner on its own output and call it John's judgement.
    const id = randomUUID()
    store.save(sugg(id))

    workflow(vault).approve(id, 'qg-pass')

    expect(vaultRationalesFor(id)).toEqual([])
  })

  it('still approves when no vault is wired, rather than failing the decision', () => {
    // Capture is additive. A missing vault must never turn a legitimate approval into an error —
    // losing the reasoning is bad, losing the DECISION would be worse.
    const id = randomUUID()
    store.save(sugg(id))

    const res = workflow(undefined).approve(id, `human:unblocks-loop:${JOHN_APPROVES}`)

    expect(res.success).toBe(true)
    expect(store.get(id)!.reviewReason).toBe(`human:unblocks-loop:${JOHN_APPROVES}`)
  })
})

describe('FR-050 — the reason must survive the file round-trip, not just the assignment', () => {
  // Found by live-running the built CLI, NOT by any unit test: the frontmatter serializer wraps
  // strings in double quotes WITHOUT escaping, and `reviewReason` was the one reason-bearing field
  // that skipped the sanitisation `lastError` and `machineReason` both apply. A newline therefore
  // terminated the YAML value early and the rest of John's sentence was silently dropped — on the
  // exact field this whole change exists to protect. Verbatim text is preserved in the vault
  // markdown (fenced, unescaped); this field only has to survive legibly and completely.
  const cases: ReadonlyArray<[string, string]> = [
    ['embedded double quotes', 'human:none: keep the "why" — that is the point'],
    ['a newline', 'human:none: first line\nsecond line'],
    ['a carriage return', 'human:none: first line\r\nsecond line'],
    ['a colon', 'human:none: reason: because'],
  ]

  it.each(cases)('survives %s', (_name, reason) => {
    const id = randomUUID()
    store.save(sugg(id))

    store.updateStatus(id, 'approved', reason)

    const back = store.get(id)!.reviewReason!
    // Full equality modulo the two documented, deliberate transliterations (newlines → spaces,
    // `"` → `'`). Asserting equality rather than `toContain` on fragments means a future change
    // that drops or reorders any part of his sentence fails here.
    const normalise = (s: string) => s.replace(/"/g, "'").replace(/\s+/g, ' ').trim()
    expect(normalise(back)).toBe(normalise(reason))
    expect(back).not.toContain('\n')
    expect(isHumanReason(back)).toBe(true)
  })

  it('keeps a long reason legible rather than letting it corrupt the file', () => {
    const id = randomUUID()
    store.save(sugg(id))
    const long = `human:none: ${'x'.repeat(2000)}`

    store.updateStatus(id, 'approved', long)

    const back = store.get(id)!.reviewReason!
    expect(back.length).toBeLessThanOrEqual(600)
    expect(isHumanReason(back)).toBe(true)
    expect(store.get(id)!.status).toBe('approved')
  })
})

describe('"all of my responses" — the explain seam', () => {
  // Found by walking John's real Monday path, not by a spec line. `explain` is his answer when the
  // PROPOSAL is unjudgeable — high-value signal about the proposal, not about the idea. It leaves
  // the suggestion pending, so it comes round again; and because a later verdict is also a human
  // reason, it overwrote the explanation in the single `reviewReason` slot and the words were gone.
  // Exactly the defect just fixed for approvals, one seam over.
  it('preserves an explanation that a LATER verdict overwrites on the suggestion file', () => {
    const id = randomUUID()
    store.save(sugg(id))

    // Week 1: he cannot judge it, and says why.
    recordWeeklyVerdict(
      store,
      id,
      { verdict: 'explain', code: null, text: 'I cannot tell if this touches the broker or the CLI' },
      deps(),
    )
    // Week 2: the proposal is rewritten and he approves it.
    recordWeeklyVerdict(store, id, { verdict: 'approve', code: 'unblocks', text: 'clearer now' }, deps())

    // The slot legitimately holds the latest verdict...
    expect(store.get(id)!.reviewReason).toContain('clearer now')
    expect(store.get(id)!.reviewReason).not.toContain('broker or the CLI')
    // ...and BOTH responses survive in the corpus, in order.
    const texts = vaultRationalesFor(id)
    expect(texts).toEqual([
      'I cannot tell if this touches the broker or the CLI',
      'clearer now',
    ])
  })

  it('files an explanation under its own verdict, never as an approval or a rejection', () => {
    // Contamination guard: `explain` is explicitly NOT a decision (weekly-session.ts), and banking
    // it as a rejection is the exact inversion an earlier live review already exposed — it would
    // teach the learner the IDEA was bad when the PROPOSAL was bad.
    const id = randomUUID()
    store.save(sugg(id))

    recordWeeklyVerdict(store, id, { verdict: 'explain', code: null, text: 'what does this touch?' }, deps())

    const rows = readDecisionRationales(db, { suggestionId: id })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reviewVerdict).toBe('explain')
    expect(rows.some((r) => r.reviewVerdict === 'approve' || r.reviewVerdict === 'reject')).toBe(false)
    // And it is still pending — capture must not have moved the status.
    expect(store.get(id)!.status).toBe('pending')
  })

  it('records nothing for a contentless non-decision', () => {
    const id = randomUUID()
    store.save(sugg(id))

    recordWeeklyVerdict(store, id, { verdict: 'explain', code: null, text: '   ' }, deps())

    expect(readDecisionRationales(db, { suggestionId: id })).toEqual([])
  })
})

describe('FR-053 on the OTHER seam — `scns review approve|reject` must not fail silently', () => {
  // Raised by independent grading of the first cut: the weekly loop surfaced capture failures to
  // John's face, but `captureRationale` in review.ts returned void and DISCARDED the errors, so the
  // one-shot CLI printed a tick and said nothing while his reasoning went nowhere. That is the exact
  // defect class this whole change exists to remove, reintroduced one seam over.
  function workflowWithBrokenVault() {
    const exploding = {
      ...vault,
      write: () => {
        throw new Error('EACCES: permission denied')
      },
    } as unknown as typeof vault
    const executor = { generatePlan: () => ({ steps: [] }), canAutoExecute: () => false } as never
    return createReviewWorkflow({ store, executor, vault: exploding })
  }

  it('returns the warning on approve so the caller can show it', () => {
    const id = randomUUID()
    store.save(sugg(id))

    const res = workflowWithBrokenVault().approve(id, `human:unblocks:${JOHN_APPROVES}`)

    // The DECISION still succeeds — losing the words is bad, losing the decision would be worse.
    expect(res.success).toBe(true)
    expect(store.get(id)!.status).toBe('approved')
    // ...but the loss is reported, not swallowed.
    expect(res.rationaleWarnings?.join(' ')).toContain('EACCES')
    expect(res.rationaleWarnings?.join(' ')).toContain('markdown rationale NOT saved')
  })

  it('returns the warning on reject too', () => {
    const id = randomUUID()
    store.save(sugg(id))

    const res = workflowWithBrokenVault().reject(id, `human:premature:${JOHN_REJECTS}`)

    expect(res.success).toBe(true)
    expect(res.rationaleWarnings?.join(' ')).toContain('EACCES')
  })

  it('reports nothing when capture succeeded', () => {
    const id = randomUUID()
    store.save(sugg(id))
    const executor = { generatePlan: () => ({ steps: [] }), canAutoExecute: () => false } as never

    const res = createReviewWorkflow({ store, executor, vault }).approve(
      id,
      `human:unblocks:${JOHN_APPROVES}`,
    )

    expect(res.rationaleWarnings).toBeUndefined()
  })
})

describe('the learner must not be fed a silently clipped rationale', () => {
  // `outcome-writer.ts` forwards `reviewReason` verbatim into `proposal_outcomes.rationale`, which
  // is what the learner reads. The frontmatter cap is a hard requirement (an unescaped 2000-char
  // value is a corruption risk), but a rationale that arrives at the learner cut off mid-sentence
  // with NO indication is a silent quality loss — it reads as though John simply stopped talking.
  it('marks a truncated reason as truncated and says where the full text lives', () => {
    const id = randomUUID()
    store.save(sugg(id))
    const long = `human:unblocks: ${'word '.repeat(300)}`

    store.updateStatus(id, 'approved', long)

    const back = store.get(id)!.reviewReason!
    expect(back.length).toBeLessThanOrEqual(600)
    expect(back).toContain('[truncated')
    expect(back).toContain('~/.scns/memory/decisions')
    // Still recognisably his, so it keeps its protection from erasure.
    expect(isHumanReason(back)).toBe(true)
  })

  it('leaves a reason that fits completely alone', () => {
    const id = randomUUID()
    store.save(sugg(id))
    const short = `human:unblocks: ${JOHN_APPROVES}`

    store.updateStatus(id, 'approved', short)

    expect(store.get(id)!.reviewReason).toBe(short)
    expect(store.get(id)!.reviewReason).not.toContain('[truncated')
  })
})

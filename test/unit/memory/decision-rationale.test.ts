/**
 * The decision-rationale corpus (E10 / US6) — capture, retrieval, and the controls that prove
 * capture did not move the learner.
 *
 * Isolated throughout: a fresh temp vault dir + a temp SQLite file per test. `~/.scns` is never
 * opened.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createVault } from '../../../src/memory/vault.js'
import {
  DECISIONS_DIR,
  decisionEntryPath,
  ensureDecisionRationaleSchema,
  ingestDecisionRationales,
  parseDecisionEntry,
  readDecisionRationales,
  recordDecisionRationale,
  renderDecisionEntry,
} from '../../../src/memory/decision-rationale.js'
import {
  LANDED_VERDICTS,
  FAILED_VERDICTS,
} from '../../../src/memory/proposal-outcomes.js'
import { statusToVerdict } from '../../../src/suggest/outcome-writer.js'
import { SuggestionStatus } from '../../../src/suggest/types.js'

let dir: string
let vault: ReturnType<typeof createVault>
let db: Database.Database

/** The words John actually types. Kept verbatim on purpose — reformatting them IS the defect. */
const JOHN_APPROVES =
  'this unblocks the weekly loop, do it first\n\nand keep the "why" — that\'s the whole point'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-decision-rationale-'))
  vault = createVault({ rootDir: join(dir, 'vault') })
  db = new Database(join(dir, 'vault.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function base(o: Record<string, unknown> = {}) {
  return {
    suggestionId: randomUUID(),
    title: 'a proposal',
    text: JOHN_APPROVES,
    author: 'human' as const,
    reviewVerdict: 'approve' as const,
    suggestionStatus: 'approved',
    ...o,
  }
}

describe('capture — both surfaces, verbatim', () => {
  it('writes the words to markdown EXACTLY as typed, newlines and quotes intact', () => {
    const input = base()
    const res = recordDecisionRationale({ vault }, input)

    expect(res.recorded).toBe(true)
    expect(res.markdownPath).toMatch(/^decisions\/\d{4}-\d{2}-\d{2}-\d{9}-approve-/)

    const content = readFileSync(join(vault.rootDir, res.markdownPath!), 'utf-8')
    // Verbatim: FR-046a forbids summarising or reformatting. Assert the exact string, not a
    // normalised form — a "close enough" assertion here would let a reflow through.
    expect(content).toContain(JOHN_APPROVES)
    expect(parseDecisionEntry(content)?.text).toBe(JOHN_APPROVES)
  })

  it('records the row with verdict AND status stored separately', () => {
    // They diverge, and that divergence is the whole reason both are stored: a backfill onto an
    // already-terminal item carries verdict `approve` while its status stays `implemented`.
    // Counting approvals by status would report ZERO on a week John approved everything.
    const input = base({ suggestionStatus: 'implemented' })
    const res = recordDecisionRationale({ vault, db }, input)
    expect(res.errors).toEqual([])

    const rows = readDecisionRationales(db, { suggestionId: input.suggestionId })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reviewVerdict).toBe('approve')
    expect(rows[0]!.suggestionStatus).toBe('implemented')
    expect(rows[0]!.author).toBe('human')
    expect(rows[0]!.text).toBe(JOHN_APPROVES)
  })

  it('keeps human and machine rationales distinguishable at read time (FR-048)', () => {
    const id = randomUUID()
    recordDecisionRationale({ vault, db }, base({ suggestionId: id }))
    recordDecisionRationale(
      { vault, db },
      base({ suggestionId: id, author: 'machine', text: 'qg-pass', reviewVerdict: 'approve' }),
    )

    expect(readDecisionRationales(db, { suggestionId: id })).toHaveLength(2)
    const human = readDecisionRationales(db, { suggestionId: id, author: 'human' })
    expect(human).toHaveLength(1)
    expect(human[0]!.text).toBe(JOHN_APPROVES)
  })

  it('is append-only — a SECOND decision is never a silent no-op', () => {
    // The `proposal_outcomes` lesson, encoded as a test. A unique constraint here would swallow the
    // second decision and return success, exactly as `ON CONFLICT DO NOTHING` does there.
    const id = randomUUID()
    recordDecisionRationale({ vault, db }, base({ suggestionId: id, text: 'first thoughts' }))
    recordDecisionRationale(
      { vault, db },
      base({ suggestionId: id, text: 'changed my mind', reviewVerdict: 'reject' }),
    )

    const rows = readDecisionRationales(db, { suggestionId: id })
    expect(rows.map((r) => r.text)).toEqual(['first thoughts', 'changed my mind'])
    expect(rows.map((r) => r.reviewVerdict)).toEqual(['approve', 'reject'])
  })

  it('gives two same-second decisions distinct paths', () => {
    const at = new Date('2026-08-03T14:00:00.000Z')
    const a = decisionEntryPath({ suggestionId: 'aaaaaaaa-1', reviewVerdict: 'approve', at })
    const b = decisionEntryPath({
      suggestionId: 'bbbbbbbb-2',
      reviewVerdict: 'approve',
      at: new Date('2026-08-03T14:00:00.500Z'),
    })
    expect(a).not.toBe(b)
  })
})

describe('FR-053 — failures are surfaced, never swallowed', () => {
  it('reports a markdown write failure instead of returning a quiet success', () => {
    const exploding = {
      ...vault,
      write: () => {
        throw new Error('EROFS: read-only file system')
      },
    } as unknown as typeof vault

    const res = recordDecisionRationale({ vault: exploding }, base())

    expect(res.recorded).toBe(false)
    expect(res.errors.join(' ')).toContain('EROFS')
    expect(res.errors.join(' ')).toContain('markdown rationale NOT saved')
  })

  it('reports an ABSENT vault rather than skipping silently (T129)', () => {
    const res = recordDecisionRationale({}, base())
    expect(res.recorded).toBe(false)
    expect(res.errors).toEqual(['no vault available — the markdown rationale was not written'])
  })
})

describe('FR-053a — the production split: CLI writes markdown, broker writes the row', () => {
  it('CLI config (vault only) captures the words durably and opens NO database', () => {
    // This is the configuration the review CLI actually runs. `vault.write` is `writeFileSync` +
    // `renameSync` (vault.ts:83) — a plain atomic filesystem write with no SQLite involvement — so
    // it cannot contend with the broker's single writer on the vault db.
    const input = base()
    const res = recordDecisionRationale({ vault }, input)

    expect(res.recorded).toBe(true)
    expect(res.markdownPath).toBeDefined()
    expect(res.rowId).toBeUndefined()
    // No row is written, and no table is created, because no db was handed over.
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='decision_rationale'").get(),
    ).toBeUndefined()
  })

  it('broker ingest carries every markdown decision into the row surface', () => {
    const a = base({ text: 'first' })
    const b = base({ text: 'second', reviewVerdict: 'reject' as const, suggestionStatus: 'rejected' })
    recordDecisionRationale({ vault }, a)
    recordDecisionRationale({ vault }, b)

    const res = ingestDecisionRationales({ db, vault })

    expect(res.scanned).toBe(2)
    expect(res.ingested).toBe(2)
    expect(res.errors).toEqual([])
    expect(readDecisionRationales(db).map((r) => r.text).sort()).toEqual(['first', 'second'])
    expect(readDecisionRationales(db).every((r) => r.sourcePath?.startsWith(DECISIONS_DIR))).toBe(
      true,
    )
  })

  it('ingest is idempotent — re-sweeping the same history adds nothing', () => {
    recordDecisionRationale({ vault }, base())
    expect(ingestDecisionRationales({ db, vault }).ingested).toBe(1)
    expect(ingestDecisionRationales({ db, vault }).ingested).toBe(0)
    expect(readDecisionRationales(db)).toHaveLength(1)
  })

  it('ingest survives one corrupt entry and names it, rather than aborting the sweep', () => {
    recordDecisionRationale({ vault }, base({ text: 'good one' }))
    vault.write(`${DECISIONS_DIR}/2026-08-03-000000000-approve-deadbeef.md`, 'not a decision entry')

    const res = ingestDecisionRationales({ db, vault })

    expect(res.ingested).toBe(1)
    expect(res.errors.join(' ')).toContain('unparseable decision entry')
    expect(readDecisionRationales(db).map((r) => r.text)).toEqual(['good one'])
  })
})

describe('retrieval (FR-052)', () => {
  it('a read against a vault that has never captured anything creates NO table', () => {
    // A read must never have a write side-effect: the live vault is opened read-only by probes and
    // by `runRewardReport` (`readonly: true`), and a migration on read would fail there — or worse,
    // succeed against a copy and mask the problem.
    expect(readDecisionRationales(db)).toEqual([])
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='decision_rationale'").get(),
    ).toBeUndefined()
  })

  it('is readable through a READ-ONLY connection, the way a probe would open it', () => {
    const id = randomUUID()
    recordDecisionRationale({ vault, db }, base({ suggestionId: id }))
    db.close()

    const ro = new Database(join(dir, 'vault.db'), { readonly: true })
    try {
      expect(readDecisionRationales(ro, { suggestionId: id, author: 'human' })[0]!.text).toBe(
        JOHN_APPROVES,
      )
    } finally {
      ro.close()
      db = new Database(join(dir, 'vault.db')) // afterEach closes it
    }
  })
})

describe('negative controls — capture must not move the reward gradient', () => {
  it('T133: `approved` is terminal for NEITHER landing nor failure', () => {
    // Asserted at RUNTIME, not in the type system: a TS-union assertion is erased at compile time
    // and cannot fail a test run. This exists to go RED if a future session "helpfully" makes
    // `approved` a terminal outcome — the disqualified option A returning by the back door.
    // Membership matters independently: because `approved` is in neither set, an approval-time row
    // would become the family's lastVerdict while contributing 0 to both counts, corrupting
    // suppression as well as the gradient.
    expect(statusToVerdict(SuggestionStatus.Approved)).toBeNull()
    expect(LANDED_VERDICTS.has('approved' as never)).toBe(false)
    expect(FAILED_VERDICTS.has('approved' as never)).toBe(false)
    // Positive control: the mapping is not simply null for everything, so the assertion above is
    // actually discriminating.
    expect(statusToVerdict(SuggestionStatus.Implemented)).toBe('implemented')
    expect(LANDED_VERDICTS.has('implemented')).toBe(true)
  })

  it('T135: capturing a rationale writes NOTHING to proposal_outcomes', () => {
    // The direct guard on FR-049: capture must not touch the table the learner counts rows in.
    ensureDecisionRationaleSchema(db)
    db.exec(`CREATE TABLE IF NOT EXISTS proposal_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, suggestion_id TEXT, entity TEXT, family TEXT,
      title TEXT, verdict TEXT, score REAL, rationale TEXT, created_at TEXT)`)

    const before = db.prepare('SELECT COUNT(*) c FROM proposal_outcomes').get() as { c: number }
    recordDecisionRationale({ vault, db }, base())
    recordDecisionRationale({ vault, db }, base({ reviewVerdict: 'reject' as const }))
    const after = db.prepare('SELECT COUNT(*) c FROM proposal_outcomes').get() as { c: number }

    expect(after.c).toBe(before.c)
    expect(after.c).toBe(0)
  })

  it('T136: an EMPTY rationale records nothing at all — not an empty placeholder', () => {
    // Absence must stay representable. A blank row would be indistinguishable at read time from a
    // decision John declined to explain, which is the distinction the corpus exists to preserve.
    const res = recordDecisionRationale({ vault, db }, base({ text: '   ' }))

    expect(res.recorded).toBe(false)
    expect(readDecisionRationales(db)).toEqual([])
    expect(existsSync(join(vault.rootDir, DECISIONS_DIR))).toBe(false)
  })
})

describe('round-trip', () => {
  it('renders and re-parses without touching the words', () => {
    const at = new Date('2026-08-03T14:30:00.000Z')
    const input = base({ code: 'unblocks-loop' })
    const parsed = parseDecisionEntry(renderDecisionEntry(input, at))

    expect(parsed).toMatchObject({
      suggestionId: input.suggestionId,
      text: JOHN_APPROVES,
      author: 'human',
      reviewVerdict: 'approve',
      suggestionStatus: 'approved',
      code: 'unblocks-loop',
      recordedAt: at.toISOString(),
      title: 'a proposal',
    })
  })
})

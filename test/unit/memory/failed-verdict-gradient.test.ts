/**
 * T147b / FR-059 — the learner's failure gradient counts human REFUSALS, not build failures.
 *
 * ⚠️ This file deliberately defends the OPPOSITE invariant to
 * `test/unit/suggest/approval-rationale.test.ts` (T135 / FR-049), which asserts that *rationale
 * capture* leaves the gradient exactly where it was. FR-059 moves the gradient **on purpose**.
 * Co-locating the two produces a suite that contradicts itself — the unsatisfiable-task shape
 * T124 had to correct — so they live apart and each test is named for the invariant it defends.
 *
 * Both are true at once because they are about different causes: writing down *why* John decided
 * must not change the arithmetic; deciding that a *build failure was never his decision* must.
 *
 * Isolation: temp SQLite file per test; the live vault is never opened.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FAILED_VERDICTS,
  LANDED_VERDICTS,
  recordProposalOutcome,
  aggregateOutcomesByEntity,
  type ProposalVerdict,
} from '../../../src/memory/proposal-outcomes.js'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import type Database from 'better-sqlite3'

let dir: string
let db: Database.Database

const ENTITY = 'broker'
const FAMILY = 'broker-port-precedence'

function record(verdict: ProposalVerdict, suggestionId: string): void {
  recordProposalOutcome(db, {
    entity: ENTITY,
    family: FAMILY,
    title: `proposal ${suggestionId}`,
    verdict,
    suggestionId,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-fr059-'))
  db = openMemoryDb(join(dir, 'vault.db'))
})

afterEach(() => {
  closeMemoryDb(db)
  rmSync(dir, { recursive: true, force: true })
})

describe('FR-059 — set membership, asserted at RUNTIME', () => {
  // T133's lesson: a TypeScript union assertion is erased at compile time and can never fail a
  // run. These read the actual Set at runtime, so a future edit to the constant fails loudly.
  it('`failed` is NOT a failure verdict', () => {
    expect(FAILED_VERDICTS.has('failed')).toBe(false)
  })

  it('`rejected` and `reverted` remain failure verdicts', () => {
    expect(FAILED_VERDICTS.has('rejected')).toBe(true)
    expect(FAILED_VERDICTS.has('reverted')).toBe(true)
  })

  it('the failure set is exactly {rejected, reverted} — nothing crept in', () => {
    expect([...FAILED_VERDICTS].sort()).toEqual(['rejected', 'reverted'])
  })

  it('`failed` and `needs-human` are in NEITHER set, so they contribute 0 to both counts', () => {
    // FR-056a. This is what makes `needs-human` usable as the escalation label without any
    // further change to the learner's arithmetic.
    for (const v of ['failed', 'needs-human'] as const) {
      expect(FAILED_VERDICTS.has(v)).toBe(false)
      expect(LANDED_VERDICTS.has(v)).toBe(false)
    }
  })
})

describe('FR-059 — the gradient the learner reads', () => {
  it('a build failure does not raise the family failure count', () => {
    record('failed', 'c0000000-0000-4000-8000-000000000001')
    record('failed', 'c0000000-0000-4000-8000-000000000002')

    const agg = aggregateOutcomesByEntity(db, ENTITY)
    // Two build failures used to reach the suppression threshold (2) on their own and stop the
    // family being proposed again. The machine failing twice is not John saying no twice.
    expect(agg.failed).toBe(0)
    expect(agg.families.get(FAMILY)?.failed).toBe(0)
  })

  it('a human rejection still raises it', () => {
    record('rejected', 'c1000000-0000-4000-8000-000000000001')

    const agg = aggregateOutcomesByEntity(db, ENTITY)
    // The negative control for the test above: the mechanism still works, it is just no longer
    // fed by the wrong events.
    expect(agg.failed).toBe(1)
    expect(agg.families.get(FAMILY)?.failed).toBe(1)
  })

  it('T133 trap: a verdict counted by neither set STILL becomes the family lastVerdict', () => {
    record('rejected', 'c2000000-0000-4000-8000-000000000001')
    record('failed', 'c2000000-0000-4000-8000-000000000002')

    const fam = aggregateOutcomesByEntity(db, ENTITY).families.get(FAMILY)!
    // Neutral counts are NOT sufficient — this is precisely how option A corrupted suppression.
    // `lastVerdict` is a separate channel and needs its own assertion: the counts say the build
    // failure was not a refusal, and `lastVerdict` still says the most recent thing that
    // happened was a build failure. Both are correct, and a reader must not confuse them.
    expect(fam.failed).toBe(1)
    expect(fam.lastVerdict).toBe('failed')
  })

  it('an escalated `needs-human` contributes to neither count but is the lastVerdict', () => {
    record('implemented', 'c3000000-0000-4000-8000-000000000001')
    record('needs-human', 'c3000000-0000-4000-8000-000000000002')

    const fam = aggregateOutcomesByEntity(db, ENTITY).families.get(FAMILY)!
    expect(fam.landed).toBe(1)
    expect(fam.failed).toBe(0)
    expect(fam.lastVerdict).toBe('needs-human')
  })

  it('FR-059b: the change is retroactive — historical `failed` rows leave the count on read', () => {
    // Counting happens at READ time (`aggregateOutcomesByEntity`), not at write time, so rows
    // banked before this change are re-counted under the new rule the moment it ships. This
    // test IS that property: nothing rewrote these rows, yet they no longer count.
    for (let i = 0; i < 5; i++) {
      record('failed', `c4000000-0000-4000-8000-00000000000${i}`)
    }
    const rowCount = db.prepare('SELECT COUNT(*) AS n FROM proposal_outcomes').get() as { n: number }

    expect(rowCount.n).toBe(5)
    expect(aggregateOutcomesByEntity(db, ENTITY).failed).toBe(0)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import {
  recordProposalOutcome,
  aggregateOutcomesByEntity,
  listOutcomeEntities,
  LANDED_VERDICTS,
  FAILED_VERDICTS,
} from '../../../src/memory/proposal-outcomes.js'
import type Database from 'better-sqlite3'

describe('proposal-outcomes (D2b per-entity outcome memory)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => {
    closeMemoryDb(db)
  })

  it('records an outcome row and returns it with id + created_at', () => {
    const row = recordProposalOutcome(db, {
      entity: 'quality-gate',
      family: 'qg-rubric',
      title: 'Tighten quality-gate rubric scoring',
      verdict: 'implemented',
      score: 0.96,
      suggestionId: 'sugg-1',
      rationale: 'merged after green suite',
    })
    expect(row).not.toBeNull()
    expect(row!.id).toBeGreaterThan(0)
    expect(row!.entity).toBe('quality-gate')
    expect(row!.family).toBe('qg-rubric')
    expect(row!.verdict).toBe('implemented')
    expect(row!.score).toBe(0.96)
    expect(row!.suggestion_id).toBe('sugg-1')
    expect(typeof row!.created_at).toBe('string')
  })

  it('is idempotent on (suggestion_id, entity, family) — no double-count', () => {
    const a = recordProposalOutcome(db, {
      entity: 'broker',
      family: 'broker-port',
      title: 'x',
      verdict: 'implemented',
      suggestionId: 'sugg-dup',
    })
    const b = recordProposalOutcome(db, {
      entity: 'broker',
      family: 'broker-port',
      title: 'x',
      verdict: 'failed',
      suggestionId: 'sugg-dup',
    })
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(b!.id).toBe(a!.id) // returns the existing row, did not insert a second
    const n = (db.prepare('SELECT COUNT(*) n FROM proposal_outcomes').get() as { n: number }).n
    expect(n).toBe(1)
    // original verdict preserved (first write wins, like recordScalingOutcome)
    expect(b!.verdict).toBe('implemented')
  })

  it('allows multiple rows when suggestion_id is null (no false dedupe)', () => {
    recordProposalOutcome(db, { entity: 'broker', family: 'f', title: 't', verdict: 'passed-gate' })
    recordProposalOutcome(db, { entity: 'broker', family: 'f', title: 't', verdict: 'passed-gate' })
    const n = (db.prepare('SELECT COUNT(*) n FROM proposal_outcomes').get() as { n: number }).n
    expect(n).toBe(2)
  })

  it('aggregates landed/failed counts and per-family last verdict/score', () => {
    recordProposalOutcome(db, {
      entity: 'autonomy',
      family: 'fam-a',
      title: 't1',
      verdict: 'implemented',
      score: 0.9,
      suggestionId: 's1',
    })
    recordProposalOutcome(db, {
      entity: 'autonomy',
      family: 'fam-a',
      title: 't2',
      verdict: 'failed',
      score: 0.1,
      suggestionId: 's2',
    })
    recordProposalOutcome(db, {
      entity: 'autonomy',
      family: 'fam-b',
      title: 't3',
      verdict: 'rejected',
      suggestionId: 's3',
    })

    const agg = aggregateOutcomesByEntity(db, 'autonomy')
    expect(agg.entity).toBe('autonomy')
    expect(agg.total).toBe(3)
    expect(agg.landed).toBe(1)
    // FR-059: only `rejected` counts as a failure now. The third row here is `failed`, which is
    // still RECORDED and still counted in `total` — it just no longer votes for suppression.
    // Note total(3) = landed(1) + failed(1) + one row that is now neither.
    expect(agg.failed).toBe(1)
    expect(agg.families.size).toBe(2)

    const famA = agg.families.get('fam-a')!
    expect(famA.landed).toBe(1)
    // fam-a's second row is `failed` → no longer a failure count for the family.
    expect(famA.failed).toBe(0)
    // ...but `lastVerdict` still reports it. Un-counting a verdict must not amount to hiding it:
    // the family's most recent outcome genuinely WAS a build failure, and a human reading this
    // aggregate should still see that. FR-059 changes what suppresses, not what is remembered.
    expect(famA.lastVerdict).toBe('failed')
    expect(famA.lastScore).toBe(0.1)

    const famB = agg.families.get('fam-b')!
    expect(famB.failed).toBe(1)
    expect(famB.lastVerdict).toBe('rejected')
  })

  it('returns an empty aggregate for an entity with no outcomes', () => {
    const agg = aggregateOutcomesByEntity(db, 'nonexistent-entity')
    expect(agg.total).toBe(0)
    expect(agg.landed).toBe(0)
    expect(agg.failed).toBe(0)
    expect(agg.families.size).toBe(0)
  })

  it('lists distinct entities that have outcomes', () => {
    recordProposalOutcome(db, { entity: 'broker', family: 'f', title: 't', verdict: 'implemented', suggestionId: 'a' })
    recordProposalOutcome(db, { entity: 'broker', family: 'g', title: 't', verdict: 'failed', suggestionId: 'b' })
    recordProposalOutcome(db, { entity: 'vault', family: 'h', title: 't', verdict: 'implemented', suggestionId: 'c' })
    const entities = listOutcomeEntities(db).sort()
    expect(entities).toEqual(['broker', 'vault'])
  })

  it('classifies verdicts into landed/failed sets (and neither for in-flight)', () => {
    expect(LANDED_VERDICTS.has('implemented')).toBe(true)
    expect(LANDED_VERDICTS.has('merged')).toBe(true)
    expect(FAILED_VERDICTS.has('rejected')).toBe(true)
    expect(FAILED_VERDICTS.has('reverted')).toBe(true)
    // FR-059 (Phase 10f, changed 2026-08-04): `failed` is NO LONGER a failed verdict.
    //
    // This assertion was inverted deliberately, and the inversion is the point of the change.
    // `FAILED_VERDICTS` feeds family suppression, and suppression is supposed to encode "stop
    // proposing this KIND of thing" — a judgement only a human refusal (`rejected`) or a landed
    // change going bad in production (`reverted`) can support. `failed` means the machine could
    // not build it: a statement about the executor's competence on the day, not about whether
    // the idea was worth having. Counting it here let a flaky test suite silently retire an
    // entire proposal family that nobody had ever ruled against.
    //
    // Because `aggregateOutcomesByEntity` classifies at READ time rather than at write time,
    // removing the member is retroactive: rows already carrying `failed` stop suppressing on the
    // next read, with no migration and no rewriting of recorded history. That is the intended
    // mechanism, not a side effect.
    expect(FAILED_VERDICTS.has('failed')).toBe(false)
    // passed-gate is a pre-merge signal: neither a landing nor a failure
    expect(LANDED_VERDICTS.has('passed-gate')).toBe(false)
    expect(FAILED_VERDICTS.has('passed-gate')).toBe(false)
  })
})

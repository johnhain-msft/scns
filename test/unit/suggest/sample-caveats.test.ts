/**
 * C7 / FR-038 (specs/003-label-integrity-defects) — the open defects touching a verdict's sample are
 * DERIVED from the corpus, never hardcoded.
 *
 * The spec names "two records in the current quorum — 1825 and 1826" as provenance-free. Measured on
 * the live corpus 2026-08-02 there are THREE (1824, 1825, 1826), and the duplicate-binding defect
 * (issue #18) touches ZERO rows of the arm sample. A hardcoded caveat list would have reported both
 * numbers wrongly — understating the defect that is real and asserting one that is not. Deriving them
 * means the report is right on Monday and right the week after, when the counts have changed.
 */
import { describe, it, expect } from 'vitest'
import { openExperienceStore, type ExperienceStore } from '../../../src/memory/experience-store.js'
import { detectSampleCaveats } from '../../../src/suggest/weekly-report.js'

type Row = { arm: string | null; outcome: number | null; source?: string | null; conv?: string; turn?: number }

function seed(rows: readonly Row[]): ExperienceStore {
  const store = openExperienceStore(':memory:')
  const ins = store.db.prepare(
    `INSERT INTO retrieval_experience
       (query_text, retriever, explore_arm, human_outcome, answer_source, conversation_id, turn, prompt_origin)
     VALUES (?, 'magma', ?, ?, ?, ?, ?, 'human')`,
  )
  rows.forEach((r, i) =>
    // `??` would convert an explicit null BACK to the default and silently never test the
    // provenance-free case — use an explicit undefined check.
    ins.run(
      `q-${i}`,
      r.arm,
      r.outcome,
      r.source === undefined ? 'human-reask:exact-match' : r.source,
      r.conv ?? `c${i}`,
      r.turn ?? i,
    ),
  )
  return store
}

describe('C7 [US1] FR-038 — caveats are measured, not asserted', () => {
  it('names provenance-free records in the sample, with their ids', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0 },
      { arm: 'magma', outcome: 0.2, source: null },
      { arm: 'multihop-iter', outcome: 1.0, source: null },
    ])
    const caveats = detectSampleCaveats(store)
    expect(caveats.join('\n')).toMatch(/2 record/)
    expect(caveats.join('\n')).toContain('answer_source')
    store.close()
  })

  it('detects duplicate binding in the PRODUCTION shape — turn column NULL, turn encoded in answer_source', () => {
    // Measured on the live corpus 2026-08-02: `turn` is NULL on ALL 2059 rows, while 27 settled rows
    // carry their turn inside `answer_source` (`…:turn-4:conf-0.90`). A check keyed on the COLUMN can
    // therefore never fire in production — its silence is not evidence of absence, which is the exact
    // false reassurance FR-038 exists to prevent.
    const store = seed([
      { arm: 'magma', outcome: 1.0, conv: 'c1', source: 'transcript-oracle:turn-4' },
      { arm: 'multihop-iter', outcome: 0.2, conv: 'c1', source: 'followup:dispute:turn-4:conf-0.90' },
    ])
    store.db.prepare('UPDATE retrieval_experience SET turn = NULL').run()

    expect(detectSampleCaveats(store).join('\n')).toMatch(/#18|duplicate/i)
    store.close()
  })

  it('NEGATIVE CONTROL: different turns in the same conversation are NOT duplicates', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0, conv: 'c1', source: 'transcript-oracle:turn-4' },
      { arm: 'multihop-iter', outcome: 0.2, conv: 'c1', source: 'followup:dispute:turn-5:conf-0.90' },
    ])
    store.db.prepare('UPDATE retrieval_experience SET turn = NULL').run()

    expect(detectSampleCaveats(store).join('\n')).not.toMatch(/#18|duplicate/i)
    store.close()
  })

  it('NEGATIVE CONTROL: the same turn number in DIFFERENT conversations is not a duplicate', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0, conv: 'c1', source: 'transcript-oracle:turn-4' },
      { arm: 'multihop-iter', outcome: 0.2, conv: 'c2', source: 'transcript-oracle:turn-4' },
    ])
    store.db.prepare('UPDATE retrieval_experience SET turn = NULL').run()

    expect(detectSampleCaveats(store).join('\n')).not.toMatch(/#18|duplicate/i)
    store.close()
  })

  /**
   * Judge finding F3. This exercises the LEGACY branch — a populated `turn` column. Production has
   * never written that shape: `turn` is NULL on all 2059 rows of the live corpus (measured 2026-08-02,
   * docs/evidence/003-C6-corpus-scale-2026-08-02.md). It is retained deliberately, because the turn
   * expression COALESCEs the column ahead of the parsed `answer_source`, so the column path must stay
   * correct if a writer ever starts populating it — but it is NOT evidence that the production path
   * works. That is the test above ("PRODUCTION shape — turn column NULL").
   */
  it('LEGACY BRANCH (unreachable in production today): names duplicate binding via the turn COLUMN', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0, conv: 'c1', turn: 4 },
      { arm: 'multihop-iter', outcome: 0.2, conv: 'c1', turn: 4 },
    ])
    expect(detectSampleCaveats(store).join('\n')).toMatch(/#18|duplicate/i)
    store.close()
  })

  it('NEGATIVE CONTROL — returns empty when the sample is clean', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0 },
      { arm: 'multihop-iter', outcome: 0.2 },
    ])
    expect(detectSampleCaveats(store)).toEqual([])
    store.close()
  })

  it('ignores defects OUTSIDE the arm sample (unsettled / unassigned rows)', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0 },
      { arm: 'magma', outcome: null, source: null }, // unsettled → not in the sample
      { arm: null, outcome: 1.0, source: null }, // unassigned → not in the sample
    ])
    expect(detectSampleCaveats(store)).toEqual([])
    store.close()
  })
})

describe('C7 [US1] FR-038 — caveats are scoped to the VERDICT population, not the whole arm corpus', () => {
  // Judge finding F5: the caveats were measured over ARM_SAMPLE_WHERE (every arm-assigned row) while
  // the verdict is computed over {challenger, incumbent} only (promotion-gate.ts). A defect on a
  // RETIRED third arm therefore qualified a verdict it could not possibly have affected — and the
  // function's own doc comment claimed the opposite. Over-reporting is not a safe direction here: it
  // trains the reader to discount caveats that do not apply, which is how the ones that do get missed.
  it('ignores a defect on an arm outside the comparison', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0 },
      { arm: 'multihop-iter', outcome: 0.6 },
      { arm: 'hybrid', outcome: 0.2, source: null },
    ])

    expect(detectSampleCaveats(store, ['multihop-iter', 'magma'])).toEqual([])
    store.close()
  })

  it('POSITIVE CONTROL: still reports a defect on an arm INSIDE the comparison', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0, source: null },
      { arm: 'multihop-iter', outcome: 0.6 },
      { arm: 'hybrid', outcome: 0.2 },
    ])

    expect(detectSampleCaveats(store, ['multihop-iter', 'magma']).join('\n')).toContain(
      'answer_source',
    )
    store.close()
  })

  it('with no arms given, falls back to the whole arm sample rather than reporting nothing', () => {
    // A caller that cannot name the comparison must not get a silent clean bill of health.
    const store = seed([{ arm: 'hybrid', outcome: 0.2, source: null }])

    expect(detectSampleCaveats(store).join('\n')).toContain('answer_source')
    store.close()
  })
})

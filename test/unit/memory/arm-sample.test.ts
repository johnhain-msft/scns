/**
 * C2 [US1] — ONE arm-sample predicate, keyed on `explore_arm` alone.
 *
 * The defect: arm identity was written three times with the same fallback —
 * `COALESCE(explore_arm, retriever)` at `experience-store.ts:557` and `:575`, and
 * `r.explore_arm ?? r.retriever` at `kto-learner.ts:192`. A row the policy never assigned
 * (`explore_arm IS NULL`) was therefore credited to the coarse `retriever` family, i.e. to the
 * incumbent.
 *
 * Measured on the live corpus (isolated WAL-inclusive copy, 2026-08-02): the fallback keying reports
 * **magma 27 / multihop-iter 7**; keying on `explore_arm` alone reports **magma 18 / multihop-iter 7**.
 * Nine legacy unassigned rows were silently inflating the incumbent's sample by 50% — the arm the
 * verdict is meant to challenge.
 *
 * Note the third site is TypeScript, not SQL. `grep -rn "COALESCE(explore_arm" src/` — the gate T016
 * and T086 specify — returns zero hits while `kto-learner.ts:192` is still wrong, so that gate
 * false-greens. `test/unit/suggest/wiring-guard.test.ts` is not the place for it; the assertion below
 * pins the behaviour instead of the spelling.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  openExperienceStore,
  countSettledByArm,
  countServedByArm,
  countExcludedFromArmSample,
} from '../../../src/memory/experience-store.js'
import { loadRewardRows } from '../../../src/reward/kto-learner.js'

type Row = {
  arm: string | null
  outcome: number | null
  retriever?: string
  origin?: 'human' | 'machine'
}

function seed(rows: readonly Row[]) {
  const store = openExperienceStore(':memory:')
  const ins = store.db.prepare(
    `INSERT INTO retrieval_experience
       (query_text, retriever, explore_arm, human_outcome, prompt_origin)
     VALUES (?, ?, ?, ?, ?)`,
  )
  rows.forEach((r, i) =>
    ins.run(`q-${i}`, r.retriever ?? 'magma', r.arm, r.outcome, r.origin ?? 'human'),
  )
  return store
}

describe('T009 [US1] POSITIVE CONTROL — an assigned arm is counted for itself', () => {
  it('counts a settled, human-authored explore_arm row for that arm on both sides', () => {
    const store = seed([
      { arm: 'multihop-iter', outcome: 1.0 },
      { arm: 'multihop-iter', outcome: null },
    ])
    expect(countSettledByArm(store).get('multihop-iter')).toBe(1)
    expect(countServedByArm(store).get('multihop-iter')).toBe(2)
    store.close()
  })
})

describe('T010 [US1] NEGATIVE CONTROL — an UNASSIGNED row belongs to no arm', () => {
  it('does not credit explore_arm IS NULL to the coarse retriever family', () => {
    const store = seed([
      { arm: null, outcome: 1.0, retriever: 'magma' },
      { arm: null, outcome: null, retriever: 'magma' },
    ])
    // The whole defect in one assertion: this used to read `magma: 1`.
    expect(countSettledByArm(store).get('magma')).toBeUndefined()
    expect(countServedByArm(store).get('magma')).toBeUndefined()
    expect(countSettledByArm(store).size).toBe(0)
    store.close()
  })

  it('reports unassigned and machine rows as EXCLUDED rather than silently dropping them', () => {
    // FR-027c: an exclusion nobody can see is indistinguishable from a corpus that never had them.
    const store = seed([
      { arm: null, outcome: 1.0 },
      { arm: null, outcome: 0.2 },
      { arm: 'magma', outcome: 1.0, origin: 'machine' },
      { arm: 'magma', outcome: 1.0 },
    ])
    const excluded = countExcludedFromArmSample(store)
    expect(excluded.unassigned).toBe(2)
    expect(excluded.machine).toBe(1)
    expect(countSettledByArm(store).get('magma')).toBe(1) // only the human, assigned row
    store.close()
  })
})

describe('T011 [US1] — machine-authored rows never enter the arm sample', () => {
  it('excludes prompt_origin = machine from both numerator and denominator', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0, origin: 'machine' },
      { arm: 'magma', outcome: null, origin: 'machine' },
      { arm: 'magma', outcome: 1.0, origin: 'human' },
    ])
    expect(countSettledByArm(store).get('magma')).toBe(1)
    expect(countServedByArm(store).get('magma')).toBe(1) // served side uses the SAME population
    store.close()
  })

  it('NEGATIVE CONTROL: legacy NULL prompt_origin is admitted, not voided', () => {
    // `IS NOT 'machine'` is null-safe in SQLite, so rows captured before the column existed still
    // count. Tightening the future must not silently delete the existing corpus.
    const store = openExperienceStore(':memory:')
    store.db
      .prepare(
        `INSERT INTO retrieval_experience (query_text, retriever, explore_arm, human_outcome, prompt_origin)
         VALUES ('legacy', 'magma', 'magma', 1.0, NULL)`,
      )
      .run()
    expect(countSettledByArm(store).get('magma')).toBe(1)
    store.close()
  })
})

describe('T012 [US1] — the learner reads the SAME population as the report', () => {
  it('loadRewardRows keys on explore_arm alone and drops unassigned + machine rows', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0 },
      { arm: 'multihop-iter', outcome: 0.2 },
      { arm: null, outcome: 1.0, retriever: 'magma' }, // unassigned — must NOT become magma
      { arm: 'magma', outcome: 1.0, origin: 'machine' }, // machine — must NOT be a human signal
    ])

    const rows = loadRewardRows(store)
    const byArm = new Map<string, number>()
    for (const r of rows) byArm.set(r.arm, (byArm.get(r.arm) ?? 0) + 1)

    expect(rows.length).toBe(2)
    expect(byArm.get('magma')).toBe(1)
    expect(byArm.get('multihop-iter')).toBe(1)
    store.close()
  })

  it('agrees EXACTLY with countSettledByArm — report and verdict cannot disagree (SC-003)', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0 },
      { arm: 'magma', outcome: 0.8 },
      { arm: 'multihop-iter', outcome: 0.2 },
      { arm: null, outcome: 1.0 },
      { arm: 'magma', outcome: 1.0, origin: 'machine' },
    ])

    const reported = countSettledByArm(store)
    const learned = new Map<string, number>()
    for (const r of loadRewardRows(store)) learned.set(r.arm, (learned.get(r.arm) ?? 0) + 1)

    expect([...learned.entries()].sort()).toEqual([...reported.entries()].sort())
    expect(reported.get('magma')).toBe(2)
    expect(reported.get('multihop-iter')).toBe(1)
    store.close()
  })
})

/**
 * The mutation that motivated these two tests SURVIVED the behavioural suite above: restoring
 * `r.explore_arm ?? r.retriever` in `loadRewardRows` left all 7 tests green, because
 * `ARM_SAMPLE_WHERE` guarantees `explore_arm IS NOT NULL` and the fallback branch is therefore
 * unreachable. Unreachable is not the same as absent — it is one loosened predicate away from
 * returning, and that is precisely how the original defect survived the `grep "COALESCE(explore_arm"`
 * gate that T016/T086 specify. These guard the invariant instead of the symptom.
 */
describe('C2 — arm keying cannot silently regress', () => {
  it('no source file reconstructs the discarded fallback keying', () => {
    const root = fileURLToPath(new URL('../../../src', import.meta.url))
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) {
          const src = readFileSync(p, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1')
          // The judge (F5) constructed four keyings that evaded the first three patterns:
          // `||`, a ternary, SQL `IFNULL`, and a multi-line `COALESCE(\n explore_arm`. Behavioural
          // tests CANNOT catch these — `ARM_SAMPLE_WHERE` makes the fallback branch unreachable — so
          // this guard is the only defence and must cover every shape of the same idea.
          for (const [label, re] of [
            ['COALESCE(explore_arm', /COALESCE\(\s*explore_arm/i],
            ['IFNULL(explore_arm', /IFNULL\(\s*explore_arm/i],
            ['explore_arm ?? retriever', /explore_arm\s*\?\?/],
            ['explore_arm || retriever', /explore_arm\s*\|\|/],
            ['explore_arm ternary fallback', /explore_arm\s*\?[^?]/],
            ['exploreArm ?? retriever', /exploreArm\s*(\?\?|\|\|)\s*\w*[rR]etriever/],
          ] as const) {
            if (re.test(src)) offenders.push(`${p.slice(root.length + 1)}: ${label}`)
          }
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })

  it('the learner and the weekly report score the identical population', () => {
    // magma: 2 settled+assigned | multihop-iter: 1 | plus one unassigned and one machine-origin row
    const store = seed([
      { arm: 'magma', outcome: 1.0 },
      { arm: 'magma', outcome: 0.2 },
      { arm: 'multihop-iter', outcome: 1.0 },
      { arm: null, outcome: 1.0 },
      { arm: 'magma', outcome: 1.0, origin: 'machine' },
    ])

    const fromLearner = new Map<string, number>()
    for (const r of loadRewardRows(store)) fromLearner.set(r.arm, (fromLearner.get(r.arm) ?? 0) + 1)

    expect(Object.fromEntries(fromLearner)).toEqual(
      Object.fromEntries(countSettledByArm(store)),
    )
    expect(Object.fromEntries(fromLearner)).toEqual({ magma: 2, 'multihop-iter': 1 })
    store.close()
  })
})

/**
 * Judge findings F3/F4 (fresh-context adversarial review, 2026-08-02). Two clauses of the shared
 * predicate were UNPINNED — deleting them left the whole suite green:
 *   M8  `countExcludedFromArmSample`'s unassigned CASE drops its machine guard  → SURVIVED
 *   M9  `retriever != 'full'` deleted from ARM_SAMPLE_SERVED_WHERE             → SURVIVED
 * Neither is reachable on today's corpus (0 machine+unassigned rows, 0 `full` rows), which is exactly
 * why no behavioural test noticed. Both become reachable the moment the system logs such a row, and
 * the failure is silent: the full-context CONTROL arm would enter the arm sample it exists to be
 * compared against, and the exclusion partition that makes SC-003 checkable would double-count.
 */
describe('C2 — every clause of the shared predicate is pinned', () => {
  it('excludes the full-context control arm from both counters (F4)', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0 },
      { arm: 'magma', outcome: 1.0, retriever: 'full' },
      { arm: 'magma', outcome: null, retriever: 'full' },
    ])
    expect(countSettledByArm(store).get('magma')).toBe(1)
    expect(countServedByArm(store).get('magma')).toBe(1)
    store.close()
  })

  it('never counts one row in two exclusion buckets, and the partition reconciles (F3)', () => {
    const store = seed([
      { arm: 'magma', outcome: 1.0 },
      { arm: 'multihop-iter', outcome: 0.2 },
      { arm: null, outcome: 1.0 },
      { arm: 'magma', outcome: 1.0, origin: 'machine' },
      // Both machine-authored AND never assigned — the overlap case M8 exposed.
      { arm: null, outcome: 1.0, origin: 'machine' },
      { arm: 'magma', outcome: null }, // unsettled: outside the partition entirely
      { arm: 'magma', outcome: 1.0, retriever: 'full' }, // full: outside the partition entirely
    ])
    const excluded = countExcludedFromArmSample(store)
    const sampled = [...countSettledByArm(store).values()].reduce((a, b) => a + b, 0)
    const settledNonFull = (
      store.db
        .prepare(
          `SELECT COUNT(*) n FROM retrieval_experience
            WHERE human_outcome IS NOT NULL AND retriever != 'full'`,
        )
        .get() as { n: number }
    ).n

    // The property, not the two numbers: sample + exclusions must EXACTLY partition the population.
    expect(sampled + excluded.unassigned + excluded.machine).toBe(settledNonFull)
    expect(sampled).toBe(2)
    expect(excluded).toEqual({ unassigned: 1, machine: 2 })
    store.close()
  })
})

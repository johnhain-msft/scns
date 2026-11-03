/**
 * Phase D — the reward report CORE shared by `scripts/reward-report.ts` and the broker's scheduled
 * `reward-report` task.
 *
 * The incumbent used to be hardcoded `'hybrid'` — the `search:` handler's arm. The BRIEFING path
 * carries essentially all real human traffic and serves `magma`, so the learner was contrasting the
 * challenger against an arm with no settled rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  runRewardReport,
  resolveLiveIncumbent,
  resolveExperienceStorePath,
} from '../../../src/reward/reward-report-run.js'
import { humanOutcomePromotion } from '../../../src/reward/promotion-gate.js'
import { learnArmValues, loadRewardRows } from '../../../src/reward/kto-learner.js'
import {
  openExperienceStore,
  logRetrievalExperience,
} from '../../../src/memory/experience-store.js'

describe('resolveLiveIncumbent — mirrors the live briefing arm', () => {
  it('defaults to magma (the briefing default), not the search path’s hybrid', () => {
    expect(resolveLiveIncumbent({} as NodeJS.ProcessEnv)).toBe('magma')
  })
  it('follows SCNS_LIVE_MEMORY_BRIEFING when it selects hybrid', () => {
    expect(resolveLiveIncumbent({ SCNS_LIVE_MEMORY_BRIEFING: 'hybrid' } as NodeJS.ProcessEnv)).toBe(
      'hybrid',
    )
  })
  it('treats an explicit magma setting as magma', () => {
    expect(resolveLiveIncumbent({ SCNS_LIVE_MEMORY_BRIEFING: 'MAGMA' } as NodeJS.ProcessEnv)).toBe(
      'magma',
    )
  })
})

describe('runRewardReport', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reward-report-'))
    path = join(dir, 'experience.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function seed(
    rows: Array<{ arm: string; outcome: number | null; propensity: number | null }>,
  ): void {
    const store = openExperienceStore(path)
    for (const [i, r] of rows.entries()) {
      const id = logRetrievalExperience(store, {
        queryText: `q${i}`,
        levers: {
          exploreArm: r.arm,
          propensity: r.propensity,
          traverse: r.arm === 'magma',
        },
        retrievedChunkIds: [1],
        conversationId: 'c1',
        turn: i,
        latencyMs: 10,
      })
      if (r.outcome !== null && id != null) {
        store.db
          .prepare('UPDATE retrieval_experience SET human_outcome = ? WHERE id = ?')
          .run(r.outcome, id)
      }
    }
    store.close()
  }

  it('reports honestly when the store does not exist (no throw, ok=false)', () => {
    const out = runRewardReport({ path: join(dir, 'missing.db') })
    expect(out.ok).toBe(false)
    expect(out.settledRows).toBe(0)
    expect(out.text).toContain('no experience store')
  })

  it('emits an insufficient-data null on a single arm rather than proposing a switch', () => {
    seed(Array.from({ length: 6 }, () => ({ arm: 'magma', outcome: 1, propensity: 1 })))
    const out = runRewardReport({ path, incumbent: 'magma' })
    expect(out.ok).toBe(true)
    expect(out.arms).toEqual(['magma'])
    expect(out.text).toContain('incumbent=magma')
  })

  it('surfaces BOTH arms once a challenger has settled rows (the Phase B goal)', () => {
    seed([
      ...Array.from({ length: 4 }, () => ({ arm: 'magma', outcome: 1, propensity: 0.9 })),
      ...Array.from({ length: 4 }, () => ({
        arm: 'multihop-iter',
        outcome: 1,
        propensity: 0.1,
      })),
    ])
    const out = runRewardReport({ path, incumbent: 'magma' })
    expect([...out.arms].sort()).toEqual(['magma', 'multihop-iter'])
  })

  it('NEVER writes the store (read-only by construction)', () => {
    seed([{ arm: 'magma', outcome: 1, propensity: 1 }])
    const before = statSync(path)
    runRewardReport({ path, incumbent: 'magma' })
    const after = statSync(path)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('cannot CREATE a store as a side effect (fileMustExist)', () => {
    const ghost = join(dir, 'ghost.db')
    runRewardReport({ path: ghost })
    expect(() => statSync(ghost)).toThrow()
  })

  it('closes the database handle it opens', () => {
    seed([{ arm: 'magma', outcome: 1, propensity: 1 }])
    runRewardReport({ path, incumbent: 'magma' })
    // If the handle leaked, an exclusive write lock from another connection would fail.
    const w = new Database(path)
    expect(() => w.prepare('SELECT COUNT(*) FROM retrieval_experience').get()).not.toThrow()
    w.close()
  })

  /**
   * T032 / C7 (specs/003-label-integrity-defects) — the verdict must be computed whenever BOTH arms
   * have enough support, not only when `learnArmValues` happens to PROPOSE an arm.
   *
   * `learnArmValues` proposes only when the gap also clears its own `proposalMargin`, so two arms that
   * are well-sampled but CLOSE produce `proposedArm === null` — and the report then showed no verdict at
   * all. That is the "structurally unable to decide" state being rendered as silence: the reader cannot
   * distinguish "too close to call, keep labelling" from "nobody looked". Approved by John 2026-08-01
   * (spec Decision 5 / A2a): only the INVOCATION CONDITION changes; `learnArmValues`' minN and margin
   * and `promotion-gate.ts` itself are untouched.
   *
   * Invoking the gate more often is a REPORTING change, not a safety change: nothing auto-applies
   * (`executor.ts:643-651` raises NEEDS_HUMAN, FR-037b), so the only thing loosened is what reaches
   * John's Monday escalation queue — which is that queue's purpose. FR-037a originally mis-classified
   * this as a hazard needing a compensating control; superseded 2026-08-02 by FR-037d, which requires
   * the verdict be EMITTED with its weakness named. See spec.md → "Framing: what the Monday review IS
   * and IS NOT".
   */
  describe('FR-037a [US1] ZERO-VARIANCE at exactly minN — PINNED AS OBSERVED, NOT ENDORSED', () => {
    /**
     * Judge finding F4. An earlier comment in this file dismissed constant-valued arms as "an artifact
     * of synthetic data". That was WRONG, and the dismissal is the finding: `HUMAN_OUTCOME_GRADIENT`
     * has **six** discrete values {1.0, 0.8, 0.6, 0.4, 0.2, 0.0} — `ignored: 0.4` was omitted by an
     * earlier count of "five" — so five settled outcomes landing on one value is entirely ordinary,
     * and T032 exists precisely to invoke the gate more often at n=5.
     *
     * Measured against the UNMODIFIED gate:
     *   all 0.8 vs all 0.6  → promote=true  LB=0.2000   n=5/5
     *   all 0.2 vs all 0.0  → promote=true  LB=0.2000   n=5/5
     *   all 1.0 vs all 0.8  → promote=true  LB=0.2000   n=5/5
     *   real live variance  → promote=false LB=-0.2251  n=5/5
     *
     * With zero within-arm variance the Welch bound collapses onto the raw difference, so ANY positive
     * gap certifies at the minimum sample size. The true unsafe region is not "zero variance" but the
     * continuous region `s²c + s²i < 0.0739`, where a single 0.2 gradient step already certifies at n=5.
     *
     * This is NOT a safety guardrail and must not be gated. Per FR-037d (2026-08-02, John's ruling),
     * it is a REPORTING characteristic to be DISCLOSED: the verdict is emitted and the report states
     * that the bound collapsed onto the raw gap and is escalated for judgement. Withholding it would
     * re-introduce the "silence reads as nothing to report" defect commit 3bb43bd already fixed.
     * `promotion-gate.ts` stays byte-identical (A2); the behaviour is pinned here so it cannot be
     * forgotten, not so it can be suppressed.
     *
     * Not reachable on the live corpus today: magma var 0.1328, multihop-iter var 0.1467.
     */
    it('a zero-variance 5-vs-5 sample DOES promote — recorded so the hole cannot be forgotten', () => {
      const flat = (arm: string, v: number) =>
        Array.from({ length: 5 }, () => ({ arm, outcome: v, propensity: 0.5 }))
      seed([...flat('magma', 0.6), ...flat('multihop-iter', 0.8)])

      const out = runRewardReport({ path, incumbent: 'magma', promotion: humanOutcomePromotion })

      expect(out.promotion).toBeDefined()
      expect(out.promotion!.promote).toBe(true)
      expect(out.promotion!.deltaLowerBound).toBeCloseTo(0.2, 4)
      expect(out.promotion!.nChallenger).toBe(5)
    })

    it('CONTRAST: the same n with realistic variance does NOT promote', () => {
      const rows = (arm: string, vals: readonly number[]) =>
        vals.map((v) => ({ arm, outcome: v, propensity: 0.5 }))
      seed([
        ...rows('magma', [1, 0.2, 0.6, 0.8, 0.2]),
        ...rows('multihop-iter', [1, 0.8, 0.6, 0.2, 0.8]),
      ])

      const out = runRewardReport({ path, incumbent: 'magma', promotion: humanOutcomePromotion })

      expect(out.promotion!.promote).toBe(false)
      expect(out.promotion!.deltaLowerBound).toBeLessThan(0)
    })
  })

  describe('A1 [US1] FR-037 challenger MULTIPLICITY — pinned, because the fallback is silent', () => {
    /**
     * `BRIEFING_CHALLENGER_ARMS` holds exactly one entry today, so this is future-proofing — but the
     * fallback is `BRIEFING_CHALLENGER_ARMS.find((a) => a !== incumbent)`, which takes the FIRST
     * non-incumbent and never looks at the rest. Add a second challenger and it would be served live
     * traffic while never appearing in any verdict, and nothing would say so.
     *
     * Two separate problems, both worth pinning before someone adds an arm:
     *  1. SILENT SKIP — the second challenger is not compared and not reported as uncompared.
     *  2. MULTIPLICITY — the 95% bound is nominal for ONE comparison. Testing k challengers against
     *     one incumbent inflates the false-promotion rate; the bound would need correcting first.
     */
    it('compares the FIRST non-incumbent challenger, deterministically', () => {
      // Three arms with ample support, so nothing is excluded for want of labels.
      const vals = [1, 0.8, 0.2, 1, 0.8, 0.6]
      seed([
        ...vals.map((v) => ({ arm: 'magma', outcome: v, propensity: 0.5 })),
        ...vals.map((v) => ({ arm: 'multihop-iter', outcome: v, propensity: 0.5 })),
        ...vals.map((v) => ({ arm: 'hybrid', outcome: v, propensity: 0.5 })),
      ])

      const seen: Array<{ challenger: string; incumbent: string }> = []
      const spy: typeof humanOutcomePromotion = (rows, o) => {
        seen.push({ challenger: o.challenger, incumbent: o.incumbent })
        return humanOutcomePromotion(rows, o)
      }

      runRewardReport({ path, incumbent: 'magma', promotion: spy })

      // Exactly ONE comparison is ever made — never one per challenger.
      expect(seen).toHaveLength(1)
      expect(seen[0]).toEqual({ challenger: 'multihop-iter', incumbent: 'magma' })
    })
  })

  describe('T032 [US1] verdict gating — computed on support, not on a proposal', () => {
    // Realistic outcomes: the HUMAN_OUTCOME_GRADIENT is discrete {1.0, 0.8, 0.6, 0.4, 0.2, 0.0} (six
    // values — `ignored: 0.4` was omitted by an earlier count of "five"), so test
    // data must have real variance. Constant-valued arms give zero variance, which makes the Welch
    // bound collapse to the raw difference and promote on ANY positive gap — an artifact of synthetic
    // data, not of the gate.
    const rows = (arm: string, vals: readonly number[]) =>
      vals.map((v) => ({ arm, outcome: v, propensity: 0.5 }))
    const CLOSE_MAGMA = [1, 0.8, 0.2, 1, 0.8, 0.2, 1, 0.8, 0.2, 0.6]
    const CLOSE_CHALL = [1, 0.8, 0.2, 1, 0.8, 0.2, 1, 0.8, 0.6, 0.2]

    it('produces a verdict when both arms clear the minimum but the gap is INSIDE the margin', () => {
      seed([...rows('magma', CLOSE_MAGMA), ...rows('multihop-iter', CLOSE_CHALL)])
      const store = openExperienceStore(path)
      const learned = learnArmValues(loadRewardRows(store), { incumbent: 'magma' })
      store.close()
      // The precondition the OLD gate required is absent — this is the whole point of T032.
      expect(learned.proposedArm).toBeNull()

      const out = runRewardReport({ path, incumbent: 'magma', promotion: humanOutcomePromotion })
      expect(out.ok).toBe(true)
      expect(out.promotion).toBeDefined()
      expect(out.promotion!.promote).toBe(false)
      expect(out.promotion!.nIncumbent).toBe(10)
      expect(out.promotion!.nChallenger).toBe(10)
      // An honest null: reported WITH its bound, so "hold" is legible as under-powered.
      expect(out.promotion!.deltaLowerBound).toBeLessThan(0)
    })

    it('does not fabricate a verdict when the challenger is BELOW the minimum', () => {
      seed([...rows('magma', CLOSE_MAGMA), ...rows('multihop-iter', [1, 0.8])])
      const out = runRewardReport({ path, incumbent: 'magma', promotion: humanOutcomePromotion })
      expect(out.promotion).toBeUndefined()
    })

    it('does not fabricate a verdict when the INCUMBENT is below the minimum', () => {
      seed([...rows('magma', [1, 0.8]), ...rows('multihop-iter', CLOSE_CHALL)])
      const out = runRewardReport({ path, incumbent: 'magma', promotion: humanOutcomePromotion })
      expect(out.promotion).toBeUndefined()
    })

    /**
     * FR-037a as written is NOT satisfiable and must not be asserted as though it were.
     *
     * It requires a negative control proving "a small sample with a large apparent gap does not yield
     * a promotion — the verdict must still fail on the confidence bound". Measured against the
     * unmodified gate, it does NOT: n=5 vs n=5 with means 0.12 and 0.92 and real variance yields
     * `promote = true`, one-sided 95% LB `+0.6860`. That is Welch behaving correctly — a large, clean
     * separation IS significant at n=5. The false premise is FR-037a's, not the gate's.
     *
     * `promotion-gate.ts` must stay byte-identical (A2/A2a), so this is pinned as an OBSERVED
     * behaviour with the real protections asserted alongside it. **John ruled on 2026-08-02:** the
     * verdict is emitted and its weakness named (FR-037d) — it is never withheld for being
     * statistically weak. FR-037a is superseded; the four suppression options previously drafted in
     * docs/evidence/AWAITING-JOHN.md are WITHDRAWN.
     */
    it('FR-037a — records the ACTUAL small-sample behaviour (a large clean gap DOES clear the bound)', () => {
      seed([...rows('magma', [0.2, 0, 0.2, 0, 0.2]), ...rows('multihop-iter', [1, 0.8, 1, 0.8, 1])])
      const out = runRewardReport({ path, incumbent: 'magma', promotion: humanOutcomePromotion })
      expect(out.promotion).toBeDefined()
      expect(out.promotion!.promote).toBe(true)
      expect(out.promotion!.deltaLowerBound).toBeGreaterThan(0)
      // The protection is NOT the bound at this sample size — it is FR-037b (no auto-apply),
      // pinned in test/unit/suggest/executor.test.ts, plus minN refusing below 5.
    })

    it('refuses BELOW minN even with a total separation (the bound is not consulted at all)', () => {
      seed([...rows('magma', [0, 0, 0, 0]), ...rows('multihop-iter', [1, 1, 1, 1])])
      const out = runRewardReport({ path, incumbent: 'magma', promotion: humanOutcomePromotion })
      expect(out.promotion).toBeUndefined()
    })
  })
})

describe('store path isolation (SCNS_HOME)', () => {
  // The scheduled consumer must resolve its store through `resolveScnsHome()` like the rest of the
  // SCNS data tree. Using `homedir()` directly makes an "isolated" dev/test broker silently read the
  // LIVE ~/.scns/memory/experience.db -- which is exactly how a probe in this session ended up
  // reporting on production rows while believing it was sandboxed.
  const prev = process.env.SCNS_HOME

  afterEach(() => {
    if (prev === undefined) delete process.env.SCNS_HOME
    else process.env.SCNS_HOME = prev
  })

  it('resolves the store under SCNS_HOME when the override is set', () => {
    process.env.SCNS_HOME = '/tmp/scns-isolated-xyz'
    expect(resolveExperienceStorePath()).toBe(
      join('/tmp/scns-isolated-xyz', '.scns', 'memory', 'experience.db'),
    )
  })

  it('falls back to the real home when SCNS_HOME is unset', () => {
    delete process.env.SCNS_HOME
    expect(resolveExperienceStorePath()).toBe(join(homedir(), '.scns', 'memory', 'experience.db'))
  })

  it('runRewardReport reads the SCNS_HOME-scoped store, not the live one', () => {
    process.env.SCNS_HOME = '/tmp/scns-isolated-nonexistent-abc'
    const out = runRewardReport()
    expect(out.ok).toBe(false)
    // join(): the store path in the message is `\`-joined on win32.
    expect(out.text).toContain(join('/tmp/scns-isolated-nonexistent-abc'))
  })
})

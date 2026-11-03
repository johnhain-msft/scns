import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  learnArmValues,
  loadRewardRows,
  type RewardExperienceRow,
} from '../../../src/reward/kto-learner.js'
import { formatRewardReport } from '../../../src/reward/report.js'
import {
  openExperienceStore,
  logRetrievalExperience,
  settleHumanOutcome,
  countExcludedFromArmSample,
} from '../../../src/memory/experience-store.js'

// ── Phase D — offline KTO/IPO-style arm-value learner over the human accept-vs-waste signal,
// IPS-debiased (clipped), shrinkage-regularized, and NEVER self-certifying: its output is a PROPOSAL
// for the arm-frontier gate, not a policy flip. Reward-tamper isolation (Everitt, arXiv:1908.04734)
// is enforced STRUCTURALLY and tested below: src/reward/ has no import path to the judge, the gate,
// or any guardrail module, and no write path to the store.

const row = (
  arm: string,
  humanOutcome: number | null,
  propensity: number | null = null,
): RewardExperienceRow => ({
  arm,
  humanOutcome,
  propensity,
})

describe('learnArmValues — IPS-weighted desirability + IPO-style shrinkage', () => {
  it('skips unsettled rows and reports per-arm n', () => {
    const out = learnArmValues(
      [row('hybrid', 1.0), row('hybrid', null), row('magma', 0.0), row('magma', null)],
      { incumbent: 'hybrid' },
    )
    const byArm = Object.fromEntries(out.estimates.map((e) => [e.arm, e]))
    expect(byArm['hybrid']!.n).toBe(1)
    expect(byArm['magma']!.n).toBe(1)
  })

  it('IPS-weights explored rows by 1/propensity, clipped (CRM variance control)', () => {
    // magma explored at propensity 0.05 ⇒ raw weight 20, clipped to 10.
    const out = learnArmValues([row('magma', 1.0, 0.05), row('magma', 0.0, 0.5)], {
      incumbent: 'hybrid',
      ipsClip: 10,
      shrinkStrength: 0, // isolate the IPS math
    })
    const magma = out.estimates.find((e) => e.arm === 'magma')!
    // weighted mean = (10*1.0 + 2*0.0) / 12 = 0.8333
    expect(magma.rawMean).toBeCloseTo(10 / 12, 4)
  })

  it('shrinks toward the prior so a unanimous-accept run cannot collapse the estimate (IPO)', () => {
    const rows = [row('magma', 1.0), row('magma', 1.0), row('magma', 1.0)]
    const out = learnArmValues(rows, { incumbent: 'hybrid', shrinkStrength: 10 })
    const magma = out.estimates.find((e) => e.arm === 'magma')!
    expect(magma.rawMean).toBe(1.0)
    expect(magma.shrunkMean).toBeLessThan(1.0) // pulled toward the prior — never a runaway certainty
    expect(magma.shrunkMean).toBeGreaterThan(magma.prior)
  })

  it('proposes a non-incumbent arm ONLY with min-n support AND a margin over the incumbent — and NEVER certifies', () => {
    const many = (arm: string, v: number, k: number): RewardExperienceRow[] =>
      Array.from({ length: k }, () => row(arm, v))
    const winner = learnArmValues([...many('hybrid', 0.4, 20), ...many('magma', 0.9, 20)], {
      incumbent: 'hybrid',
      minN: 10,
    })
    expect(winner.proposedArm).toBe('magma')
    expect(winner.certified).toBe(false) // ALWAYS — certification belongs to the evaluator gate

    const thin = learnArmValues([...many('hybrid', 0.4, 20), ...many('magma', 0.9, 3)], {
      incumbent: 'hybrid',
      minN: 10,
    })
    expect(thin.proposedArm).toBeNull() // 3 samples never proposes

    const narrow = learnArmValues([...many('hybrid', 0.5, 20), ...many('magma', 0.52, 20)], {
      incumbent: 'hybrid',
      minN: 10,
      proposalMargin: 0.05,
    })
    expect(narrow.proposedArm).toBeNull() // within the margin ⇒ no proposal
  })

  it('returns an empty proposal for no settled rows', () => {
    const out = learnArmValues([row('hybrid', null)], { incumbent: 'hybrid' })
    expect(out.proposedArm).toBeNull()
    expect(out.estimates).toEqual([])
  })
})

describe('loadRewardRows — READ-ONLY extraction from the experience store', () => {
  it('loads settled, arm-assigned rows only, with propensity from flag_state', () => {
    // HISTORY (C2, specs/003-label-integrity-defects): this test was named "arm (explore_arm ??
    // retriever)" and asserted `byQ['hybrid']` for a row logged with `levers: {}` — i.e. a row the
    // exploration policy NEVER assigned, laundered into an arm named after the default retriever
    // family. That is the defect, asserted as intended behaviour. Arm identity is now `explore_arm`
    // alone and the population is the shared `ARM_SAMPLE_WHERE`, so the learner and the weekly
    // report provably score the same rows (SC-003).
    const store = openExperienceStore(':memory:')
    const unassigned = logRetrievalExperience(store, {
      queryText: 'q1',
      levers: {},
      retrievedChunkIds: [1],
    })
    const hybrid = logRetrievalExperience(store, {
      queryText: 'q-hybrid',
      levers: { exploreArm: 'hybrid' },
      retrievedChunkIds: [3],
    })
    const b = logRetrievalExperience(store, {
      queryText: 'q2',
      levers: { traverse: true, exploreArm: 'magma', epsilon: 0.1, propensity: 0.05 },
      retrievedChunkIds: [2],
    })
    logRetrievalExperience(store, { queryText: 'unsettled', levers: {}, retrievedChunkIds: [] })
    settleHumanOutcome(store, unassigned, 1.0)
    settleHumanOutcome(store, hybrid, 1.0)
    settleHumanOutcome(store, b, 0.2)
    const rows = loadRewardRows(store)
    expect(rows).toHaveLength(2) // unsettled row excluded, AND the never-assigned row excluded
    const byQ = Object.fromEntries(rows.map((r) => [r.arm, r]))
    expect(byQ['hybrid']).toMatchObject({ humanOutcome: 1.0, propensity: null })
    expect(byQ['magma']).toMatchObject({ humanOutcome: 0.2, propensity: 0.05 })
    // The never-assigned settled row is counted as an exclusion, not merged into any arm (FR-019).
    expect(countExcludedFromArmSample(store).unassigned).toBe(1)
    store.close()
  })
})

describe('reward-tamper isolation (Everitt) — STRUCTURAL: no import path to judge/gate/guardrails, no store writes', () => {
  const rewardDir = join(__dirname, '../../../src/reward')
  const sources = readdirSync(rewardDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(rewardDir, f), 'utf8') }))

  it('src/reward/ never imports evaluator/judge/guardrail modules', () => {
    const forbidden =
      /from\s+'[^']*(judge|locomo|qa-generator|negative-memory|guardrail|gated-|dream-gates)[^']*'/
    for (const s of sources) {
      expect(s.text, `${s.file} must not import evaluator/judge/guardrail modules`).not.toMatch(
        forbidden,
      )
    }
  })
  it('src/reward/ never writes (INSERT/UPDATE/DELETE) — the learner has no causal path to its own reward', () => {
    const writeSql = /\b(INSERT|UPDATE|DELETE)\b/i
    for (const s of sources) {
      for (const line of s.text.split('\n')) {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue
        expect(line, `${s.file} must not contain write SQL: ${line.trim()}`).not.toMatch(writeSql)
      }
    }
  })
})

describe('formatRewardReport — deterministic renderer (no I/O, isolation-inherited)', () => {
  it('renders estimates, the never-certified banner, and the proposal line', () => {
    const learned = learnArmValues(
      [
        ...Array.from({ length: 20 }, () => row('hybrid', 0.4)),
        ...Array.from({ length: 20 }, () => row('magma', 0.9)),
      ],
      { incumbent: 'hybrid', minN: 10 },
    )
    const text = formatRewardReport(learned)
    expect(text).toContain('certified: false')
    expect(text).toContain('hybrid')
    expect(text).toContain('magma')
    expect(text).toContain("PROPOSAL: 'magma'")
    expect(text).toContain('AWAITING-JOHN')
  })
  it('renders the empty-store case without a proposal', () => {
    const text = formatRewardReport(learnArmValues([], { incumbent: 'hybrid' }))
    expect(text).toContain('no settled human outcomes')
    expect(text).not.toContain('PROPOSAL:')
  })
})

// ── T046 [US4] — loadRewardRows prefers the FIRST-CLASS propensity column (Foundational delta) ───
describe('T046 — first-class propensity column feeds the learner (flag_state is the legacy fallback)', () => {
  it('a row with a first-class propensity but NO flag_state propensity still carries it', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, {
      queryText: 'first-class propensity row',
      levers: { exploreArm: 'magma' }, // NOTE: no propensity in the levers/flag_state
      retrievedChunkIds: [],
      propensity: 0.05, // first-class column only
    })
    settleHumanOutcome(store, id, 1.0)
    const rows = loadRewardRows(store)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.arm).toBe('magma')
    expect(rows[0]!.propensity).toBe(0.05)
    store.close()
  })

  it('legacy rows (propensity only inside flag_state) still load — the fallback stays', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, {
      queryText: 'legacy row',
      levers: { exploreArm: 'magma', propensity: 0.2 },
      retrievedChunkIds: [],
    })
    // simulate a PRE-feature row: null out the first-class column, keep flag_state
    store.db.prepare('UPDATE retrieval_experience SET propensity = NULL WHERE id = ?').run(id)
    settleHumanOutcome(store, id, 0.8)
    const rows = loadRewardRows(store)
    expect(rows[0]!.propensity).toBe(0.2)
    store.close()
  })
})

// ── T048 [US4] — the reward report surfaces IPS/DR, effective N, and the promotion decision ─────
describe('T048 — formatRewardReport extras: DR values + promotion verdict + grounding evidence', () => {
  it('renders per-arm DR values and the promotion decision with its evidence line', () => {
    const store = openExperienceStore(':memory:')
    for (const [arm, outcome] of [
      ['magma', 1.0],
      ['magma', 0.8],
      ['hybrid', 0.4],
      ['hybrid', 0.2],
    ] as const) {
      const id = logRetrievalExperience(store, {
        queryText: `${arm} row`,
        levers: { exploreArm: arm, propensity: 0.5 },
        retrievedChunkIds: [],
        propensity: 0.5,
      })
      settleHumanOutcome(store, id, outcome)
    }
    const rows = loadRewardRows(store)
    const learned = learnArmValues(rows, { incumbent: 'hybrid' })
    const report = formatRewardReport(learned, {
      drByArm: {
        magma: { value: 0.9123, nUsed: 4, nDroppedInvalid: 0 },
        hybrid: { value: 0.3001, nUsed: 4, nDroppedInvalid: 0 },
      },
      promotion: {
        promote: false,
        challenger: 'magma',
        deltaLowerBound: -0.02,
        reason: 'no certified human-outcome win (lower bound -0.0200 ≤ 0) — the static policy stands',
      },
    })
    expect(report).toContain('DR')
    expect(report).toContain('0.9123')
    expect(report).toContain('0.3001')
    expect(report).toMatch(/PROMOTION: HOLD/i)
    expect(report).toContain('-0.02')
    expect(report).toMatch(/static policy stands/)
    store.close()
  })

  it('renders a PROMOTE decision when the verdict says so — evidence quoted, never implied', () => {
    const learned = learnArmValues([], { incumbent: 'hybrid' })
    const report = formatRewardReport(learned, {
      promotion: {
        promote: true,
        challenger: 'magma-reinforced',
        deltaLowerBound: 0.3261,
        reason: 'challenger beats the static policy on settled human outcomes (one-sided 95% LB 0.3261 > 0)',
      },
    })
    expect(report).toMatch(/PROMOTION: PROMOTE 'magma-reinforced'/)
    expect(report).toContain('0.3261')
  })

  it('extras are OPTIONAL — the existing report is unchanged without them (negative control)', () => {
    const learned = learnArmValues([], { incumbent: 'hybrid' })
    expect(formatRewardReport(learned)).not.toMatch(/PROMOTION|DR/)
  })
})

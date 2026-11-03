/**
 * Phase B/C — exploration on the LIVE BRIEFING path (RED-first), with POSITIVE and NEGATIVE controls.
 *
 * ## Why this file exists
 * Measured 2026-07-27: `SCNS_EXPLORE_ROUTING=1` had been set on the live broker for days and produced
 * ZERO challenger rows, because `selectExplorationArm` was only ever called from the `search:` handler
 * (`cli.ts:1096`) while the `briefing:` handler carried 85 of 87 recent rows. Setting the lever was
 * never sufficient — the policy was wired to a path that no longer carries traffic.
 *
 * These tests pin the POLICY seam the briefing handler calls. They are pure and deterministic (the RNG
 * is injected), hermetic (`:memory:` stores), and never touch the live vault or live experience store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  selectBriefingArm,
  resolveBootstrapEpsilon,
  BRIEFING_CHALLENGER_ARMS,
  BOOTSTRAP_EPSILON,
  STEADY_EPSILON,
} from '../../../src/memory/explore-router.js'
import {
  openExperienceStore,
  logRetrievalExperience,
  countSettledByArm,
  countExcludedFromArmSample,
  settleHumanOutcome,
  type ExperienceStore,
} from '../../../src/memory/experience-store.js'

/** An RNG that replays a scripted sequence — makes the ε-policy fully deterministic under test. */
function scriptedRng(values: readonly number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]!
}

describe('Phase B — selectBriefingArm: the briefing path can reach a CHALLENGER arm', () => {
  it('NEGATIVE CONTROL: exploration disabled ⇒ incumbent served, and NOTHING is logged as an arm', () => {
    const d = selectBriefingArm({
      enabled: false,
      humanAuthored: true,
      incumbent: 'magma',
      rng: scriptedRng([0, 0]), // would ALWAYS explore if the lever were on
    })
    expect(d.explore).toBe(false)
    expect(d.servedArm).toBe('magma')
    // The whole point of the negative control: with the lever off the row must stay byte-identical to
    // pre-change behavior — explore_arm/propensity/epsilon are NOT recorded at all (NULL), never 1.0.
    expect(d.record).toBe(false)
    expect(d.propensity).toBeUndefined()
    expect(d.epsilon).toBeUndefined()
  })

  it('POSITIVE CONTROL: lever on + a forced RNG ⇒ the CHALLENGER arm is served and recorded', () => {
    const d = selectBriefingArm({
      enabled: true,
      humanAuthored: true,
      incumbent: 'magma',
      epsilon: 0.5,
      rng: scriptedRng([0.0, 0.0]), // draw < ε ⇒ explore; then arm index 0
    })
    expect(d.explore).toBe(true)
    expect(d.servedArm).toBe('multihop-iter')
    expect(d.record).toBe(true)
    // propensity of the TAKEN action = ε/|arms|; with a single challenger that is exactly ε.
    expect(d.propensity).toBeCloseTo(0.5 / BRIEFING_CHALLENGER_ARMS.length, 10)
    expect(d.epsilon).toBe(0.5)
  })

  it('an EXPLOIT draw under an ON lever records the incumbent arm with propensity 1−ε', () => {
    const d = selectBriefingArm({
      enabled: true,
      humanAuthored: true,
      incumbent: 'magma',
      epsilon: 0.5,
      rng: scriptedRng([0.99]), // draw ≥ ε ⇒ exploit
    })
    expect(d.explore).toBe(false)
    expect(d.servedArm).toBe('magma')
    expect(d.record).toBe(true) // ⇐ this is what makes ≥2 ARMS visible, not just ≥1
    expect(d.propensity).toBeCloseTo(0.5, 10)
  })

  it('the challenger set is exactly {multihop-iter} — magma is the briefing INCUMBENT, not a challenger', () => {
    // Sampling the incumbent as an "exploration" would burn budget on a no-op.
    expect([...BRIEFING_CHALLENGER_ARMS]).toEqual(['multihop-iter'])
  })

  it('MACHINE-authored prompts never spend exploration budget (they can never settle)', () => {
    const d = selectBriefingArm({
      enabled: true,
      humanAuthored: false,
      incumbent: 'magma',
      epsilon: 1.0, // would explore with certainty if it were allowed to
      rng: scriptedRng([0.0, 0.0]),
    })
    expect(d.explore).toBe(false)
    expect(d.servedArm).toBe('magma')
    expect(d.record).toBe(false)
  })

  it('respects the 24h store bound and the per-process cap (a burst cannot flood live traffic)', () => {
    const capped = selectBriefingArm({
      enabled: true,
      humanAuthored: true,
      incumbent: 'magma',
      epsilon: 1.0,
      explorations24h: 999,
      rng: scriptedRng([0.0, 0.0]),
    })
    expect(capped.explore).toBe(false)
    expect(capped.boundHit).toBe(true)
    expect(capped.servedArm).toBe('magma')

    const procCapped = selectBriefingArm({
      enabled: true,
      humanAuthored: true,
      incumbent: 'magma',
      epsilon: 1.0,
      processCount: 999,
      rng: scriptedRng([0.0, 0.0]),
    })
    expect(procCapped.explore).toBe(false)
    expect(procCapped.boundHit).toBe(true)
  })

  it('serves the hybrid incumbent unchanged when the briefing is configured to hybrid', () => {
    const d = selectBriefingArm({
      enabled: true,
      humanAuthored: true,
      incumbent: 'hybrid',
      epsilon: 0.5,
      rng: scriptedRng([0.99]),
    })
    expect(d.servedArm).toBe('hybrid')
  })

  it('is FAIL-SAFE: a throwing RNG degrades to the incumbent instead of breaking the briefing', () => {
    const d = selectBriefingArm({
      enabled: true,
      humanAuthored: true,
      incumbent: 'magma',
      epsilon: 0.5,
      rng: () => {
        throw new Error('boom')
      },
    })
    expect(d.explore).toBe(false)
    expect(d.servedArm).toBe('magma')
    expect(d.record).toBe(false)
  })
})

describe('Phase C — bootstrap assignment probability with decay (John-approved: 50/50 → 0.1)', () => {
  let store: ExperienceStore
  beforeEach(() => {
    store = openExperienceStore(':memory:')
  })
  afterEach(() => store.close())

  it('BOOTSTRAP: while any arm is under minN, assignment is balanced (ε = 0.5)', () => {
    expect(resolveBootstrapEpsilon(new Map(), { arms: ['magma', 'multihop-iter'], minN: 10 })).toBe(
      BOOTSTRAP_EPSILON,
    )
    expect(BOOTSTRAP_EPSILON).toBe(0.5)
    const partial = new Map([
      ['magma', 50],
      ['multihop-iter', 9],
    ])
    expect(resolveBootstrapEpsilon(partial, { arms: ['magma', 'multihop-iter'], minN: 10 })).toBe(
      BOOTSTRAP_EPSILON,
    )
  })

  it('DECAY: once EVERY arm has minN settled rows, ε decays to the steady value (0.1)', () => {
    const full = new Map([
      ['magma', 12],
      ['multihop-iter', 10],
    ])
    expect(resolveBootstrapEpsilon(full, { arms: ['magma', 'multihop-iter'], minN: 10 })).toBe(
      STEADY_EPSILON,
    )
    expect(STEADY_EPSILON).toBe(0.1)
  })

  it('an EXPLICIT override always wins over the bootstrap schedule', () => {
    expect(
      resolveBootstrapEpsilon(new Map(), {
        arms: ['magma', 'multihop-iter'],
        minN: 10,
        override: 0.25,
      }),
    ).toBe(0.25)
    // A malformed override is ignored rather than poisoning the policy with NaN.
    expect(
      resolveBootstrapEpsilon(new Map(), {
        arms: ['magma', 'multihop-iter'],
        minN: 10,
        override: Number.NaN,
      }),
    ).toBe(BOOTSTRAP_EPSILON)
  })

  it('countSettledByArm keys on explore_arm ALONE and excludes never-assigned rows', () => {
    // HISTORY (C2, specs/003-label-integrity-defects): this test previously asserted
    // `expect(byArm.get('magma')).toBe(2)` with the comment "the explored incumbent row + the legacy
    // magma-family row" — i.e. the `COALESCE(explore_arm, retriever)` fallback was not merely
    // untested, it was ASSERTED as intended. That is why the defect survived: any correct fix turned
    // this suite red, so the fix would have looked like the regression. On the live corpus the
    // fallback credited 9 never-assigned rows to the incumbent, reporting magma 27 vs multihop-iter 7
    // where the truth was 18 vs 7 — a 50% inflation against the very challenger it was compared with.
    // A row the policy never assigned has NO arm identity; it is excluded and counted separately by
    // `countExcludedFromArmSample`, never merged into a family (FR-019).
    const incumbent = logRetrievalExperience(store, {
      queryText: 'incumbent turn',
      levers: { traverse: true, synthesize: true, exploreArm: 'magma' },
      retrievedChunkIds: [1],
      propensity: 0.5,
    })
    const challenger = logRetrievalExperience(store, {
      queryText: 'challenger turn',
      levers: { multiHop: true, synthesize: true, exploreArm: 'multihop-iter' },
      retrievedChunkIds: [2],
      propensity: 0.5,
    })
    const legacy = logRetrievalExperience(store, {
      queryText: 'legacy row with no explore_arm',
      levers: { traverse: true },
      retrievedChunkIds: [3],
    })
    settleHumanOutcome(store, incumbent, 1)
    settleHumanOutcome(store, challenger, 0)
    settleHumanOutcome(store, legacy, 1)

    const byArm = countSettledByArm(store)
    expect(byArm.get('magma')).toBe(1) // the explored incumbent row ONLY
    expect(byArm.get('multihop-iter')).toBe(1)
    // The legacy row is not silently dropped either — it is visible as an exclusion.
    expect(countExcludedFromArmSample(store).unassigned).toBe(1)
  })

  it('counts only SETTLED rows — an unsettled challenger row must not advance the decay', () => {
    const id = logRetrievalExperience(store, {
      queryText: 'unsettled challenger',
      levers: { multiHop: true, exploreArm: 'multihop-iter' },
      retrievedChunkIds: [1],
      propensity: 0.5,
    })
    expect(id).toBeGreaterThan(0)
    expect(countSettledByArm(store).get('multihop-iter')).toBeUndefined()
  })
})

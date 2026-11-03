/**
 * Phase B-EXPLORE (§7b) — ε-router POLICY unit tests. Pure + deterministic (scripted/seeded RNG); no DB,
 * no ACP, no live wiring. Proves: DEFAULT-OFF gate, ε explore-rate, uniform arm pick, propensity, and the
 * 24h + per-process bounds. The router is exercised for real (arms + judged outcomes) ONLY on the offline
 * judged harness path (decision C) — these tests lock the policy's correctness before any such run.
 */
import { describe, it, expect } from 'vitest'
import {
  EXPLORE_ARMS,
  EXPLORE_ROUTING_ENV,
  DEFAULT_EPSILON,
  DEFAULT_MAX_EXPLORATIONS_24H,
  DEFAULT_MAX_EXPLORATIONS_PER_PROCESS,
  BOOTSTRAP_EPSILON,
  isExploreRoutingEnabled,
  selectExplorationArm,
  resolveBootstrapEpsilon,
  mulberry32,
} from '../../../src/memory/explore-router.js'
import {
  openExperienceStore,
  countSettledByArm,
  type ExperienceStore,
} from '../../../src/memory/experience-store.js'

/** A scripted RNG returning the given values in order (throws if over-drawn) — makes the policy fully deterministic. */
function scriptedRng(values: readonly number[]): () => number {
  let i = 0
  return () => {
    if (i >= values.length) throw new Error(`scriptedRng over-drawn (>${values.length})`)
    return values[i++]!
  }
}

describe('isExploreRoutingEnabled — DEFAULT-OFF', () => {
  it("is OFF unless SCNS_EXPLORE_ROUTING === '1'", () => {
    expect(isExploreRoutingEnabled({})).toBe(false) // unset ⇒ off
    expect(isExploreRoutingEnabled({ [EXPLORE_ROUTING_ENV]: '0' })).toBe(false)
    expect(isExploreRoutingEnabled({ [EXPLORE_ROUTING_ENV]: 'true' })).toBe(false)
    expect(isExploreRoutingEnabled({ [EXPLORE_ROUTING_ENV]: '' })).toBe(false)
    expect(isExploreRoutingEnabled({ [EXPLORE_ROUTING_ENV]: '1' })).toBe(true)
  })
  it('exposes the specified defaults', () => {
    expect(EXPLORE_ARMS).toEqual(['magma', 'multihop-iter']) // de-strawmanned: only FAITHFUL variant arms
    expect(DEFAULT_EPSILON).toBe(0.1)
    expect(DEFAULT_MAX_EXPLORATIONS_24H).toBe(20)
    expect(DEFAULT_MAX_EXPLORATIONS_PER_PROCESS).toBe(20)
  })
})

describe('selectExplorationArm — explore/exploit + uniform arm + propensity', () => {
  it('EXPLOITS hybrid when the first draw ≥ ε (propensity 1−ε, no arm)', () => {
    const d = selectExplorationArm({ rng: scriptedRng([0.1]), epsilon: 0.1 }) // 0.1 >= 0.1 ⇒ exploit
    expect(d.explore).toBe(false)
    expect(d.arm).toBeUndefined()
    expect(d.propensity).toBeCloseTo(0.9, 12)
    expect(d.boundHit).toBe(false)
  })

  it('EXPLORES when the first draw < ε, picking the arm UNIFORMLY from the second draw (propensity ε/|arms|)', () => {
    // second draw buckets [0,1/2)->magma, [1/2,1)->multihop-iter
    const magma = selectExplorationArm({ rng: scriptedRng([0.0, 0.0]), epsilon: 0.1 })
    const multi = selectExplorationArm({ rng: scriptedRng([0.05, 0.75]), epsilon: 0.1 })
    expect(magma).toMatchObject({ explore: true, arm: 'magma' })
    expect(multi).toMatchObject({ explore: true, arm: 'multihop-iter' })
    for (const d of [magma, multi]) expect(d.propensity).toBeCloseTo(0.1 / 2, 12)
  })

  it('ε=0 (or empty arms) ⇒ always exploit, never draws an arm', () => {
    expect(selectExplorationArm({ rng: () => 0, epsilon: 0 }).explore).toBe(false)
    expect(selectExplorationArm({ rng: () => 0, arms: [] }).explore).toBe(false)
  })

  it('the 24h store bound forces exploit (boundHit) even when the RNG would explore', () => {
    const d = selectExplorationArm({
      rng: () => 0, // would explore if allowed
      epsilon: 0.1,
      explorations24h: 20,
      maxExplorations24h: 20,
    })
    expect(d).toMatchObject({ explore: false, boundHit: true, propensity: 1 })
  })

  it('the per-process cap forces exploit (boundHit) independently of the 24h count', () => {
    const d = selectExplorationArm({
      rng: () => 0,
      epsilon: 0.1,
      explorations24h: 0,
      processCount: 20,
      maxPerProcess: 20,
    })
    expect(d).toMatchObject({ explore: false, boundHit: true, propensity: 1 })
  })

  it('just under the bounds still explores', () => {
    const d = selectExplorationArm({
      rng: scriptedRng([0.0, 0.0]),
      epsilon: 0.1,
      explorations24h: 19,
      maxExplorations24h: 20,
      processCount: 19,
      maxPerProcess: 20,
    })
    expect(d).toMatchObject({ explore: true, arm: 'magma', boundHit: false })
  })
})

describe('mulberry32 — deterministic PRNG', () => {
  it('is reproducible from a seed and stays in [0,1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const seqA = [a(), a(), a(), a()]
    const seqB = [b(), b(), b(), b()]
    expect(seqA).toEqual(seqB)
    for (const x of seqA) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
    expect(mulberry32(43)()).not.toBe(mulberry32(42)()) // different seed ⇒ different stream
  })

  it('yields ~ε exploration over many seeded draws, every arm represented, bounded', () => {
    const rng = mulberry32(12345)
    const N = 4000
    let explored = 0
    const armCounts: Record<string, number> = { magma: 0, 'multihop-iter': 0 }
    for (let i = 0; i < N; i++) {
      const d = selectExplorationArm({ rng, epsilon: 0.1, maxExplorations24h: Number.MAX_SAFE_INTEGER, maxPerProcess: Number.MAX_SAFE_INTEGER })
      if (d.explore) {
        explored++
        armCounts[d.arm!]++
      }
    }
    // ε=0.1 over 4000 draws ⇒ ~400 explores; allow a generous statistical band.
    expect(explored).toBeGreaterThan(300)
    expect(explored).toBeLessThan(500)
    // uniform over the arms ⇒ every arm must appear in the explored slice.
    expect(Math.min(...Object.values(armCounts))).toBeGreaterThan(0)
  })
})

/**
 * T020 [US1] RED (router half) — FR-025: the live briefing path acquires NO new throw site.
 *
 * `countSettledByArm` feeds `resolveBootstrapEpsilon` on the serving path (`src/cli.ts:1265`). When
 * the strict `EvidenceRead` form lands (T022), the strict behaviour must NOT leak here: a read
 * failure must still yield an empty Map, and ε must still resolve to a finite number so the briefing
 * is served rather than 500ing.
 *
 * Contract: `specs/003-label-integrity-defects/contracts/evidence-counts.md` § Controls (Negative).
 */
describe('T020 [US1] RED — a failed evidence read still serves the briefing', () => {
  const arms = ['magma', 'multihop-iter'] as const

  it('resolveBootstrapEpsilon returns a finite number given the empty Map a failed read produces', () => {
    const store = openExperienceStore(':memory:')
    const broken = {
      ...store,
      db: {
        prepare() {
          throw new Error('injected read failure')
        },
      },
    } as unknown as ExperienceStore

    const counts = countSettledByArm(broken) // must not throw
    expect(counts.size).toBe(0)

    const eps = resolveBootstrapEpsilon(counts, { arms: [...arms] })
    expect(typeof eps).toBe('number')
    expect(Number.isFinite(eps)).toBe(true)
    // Zero support ⇒ nothing clears minN ⇒ stay in bootstrap (the conservative direction).
    expect(eps).toBe(BOOTSTRAP_EPSILON)
    store.close()
  })

  it('T013 pin — ε is BOOTSTRAP_EPSILON under BOTH the old and the corrected T007 counts', () => {
    // Re-measured 2026-08-02 (evidence: docs/evidence/003-T006-T008-foundational-2026-08-02.md).
    const oldKeying = new Map<string, number>([
      ['magma', 29],
      ['multihop-iter', 8],
    ])
    const correctedKeying = new Map<string, number>([
      ['magma', 20],
      ['multihop-iter', 8],
    ])
    // minN=10: the challenger is under-powered on BOTH keyings, so the keying fix must not move ε.
    expect(resolveBootstrapEpsilon(oldKeying, { arms: [...arms] })).toBe(BOOTSTRAP_EPSILON)
    expect(resolveBootstrapEpsilon(correctedKeying, { arms: [...arms] })).toBe(BOOTSTRAP_EPSILON)
  })
})

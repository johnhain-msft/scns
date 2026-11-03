/**
 * Step 2 ACCEPTANCE — ZERO LIVE BEHAVIOUR CHANGE: arm selection is byte-identical before and after
 * the purpose-routing rework.
 *
 * `test/fixtures/routing/briefing-arm-golden-67ff69f.json` was generated on `main @ 67ff69f`
 * (the merge of PR #41, BEFORE any Step 2 change) by driving `selectBriefingArm`,
 * `selectExplorationArm` and `resolveBootstrapEpsilon` through a fixed scenario grid on ONE seeded
 * `mulberry32(20260815)` stream shared across the whole grid — so a drift in draw ORDER, not just
 * draw value, would show. The generator is reproduced verbatim below; this test re-runs it against
 * the current code and asserts deep equality with the frozen output.
 *
 * The purpose-frame vocabulary added in Step 2 (`BRIEFING_ALTERNATE_TOOLS`, `resolveBriefingTools`)
 * must be ALIASES of the drift-era values, never new behaviour: pinned here too.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  selectBriefingArm,
  selectExplorationArm,
  resolveBootstrapEpsilon,
  mulberry32,
  BRIEFING_CHALLENGER_ARMS,
  BRIEFING_ALTERNATE_TOOLS,
  EXPLORE_ARMS,
  resolveBriefingDefaultTool,
  resolveBriefingTools,
} from '../../../src/memory/explore-router.js'
import { resolveLiveIncumbent } from '../../../src/reward/reward-report-run.js'
import { RETRIEVAL_TOOLS } from '../../../src/memory/hop-shape.js'

const FIXTURE = join(
  process.cwd(),
  'test',
  'fixtures',
  'routing',
  'briefing-arm-golden-67ff69f.json',
)

/** Verbatim copy of the generator that produced the fixture on main @ 67ff69f. */
function generate(): unknown[] {
  const rng = mulberry32(20260815)
  const out: unknown[] = []
  const epsilons = [0.5, 0.1, 0]
  const incumbents = ['magma', 'hybrid']
  for (let i = 0; i < 40; i++) {
    const epsilon = epsilons[i % epsilons.length]!
    const incumbent = incumbents[i % 2]!
    const humanAuthored = i % 5 !== 3
    const enabled = i % 7 !== 6
    const explorations24h = i % 11 === 10 ? 20 : i % 3
    const processCount = i % 13 === 12 ? 20 : 0
    const d = selectBriefingArm({
      enabled,
      humanAuthored,
      incumbent,
      rng,
      epsilon,
      explorations24h,
      processCount,
    })
    out.push({
      i,
      in: { enabled, humanAuthored, incumbent, epsilon, explorations24h, processCount },
      out: d,
    })
  }
  for (let i = 0; i < 20; i++) {
    const d = selectExplorationArm({
      rng,
      epsilon: 0.5,
      arms: ['multihop-iter'],
      explorations24h: i % 21,
      processCount: 0,
    })
    out.push({ i: 40 + i, exploration: d })
  }
  const eps = [
    resolveBootstrapEpsilon(
      new Map([
        ['magma', 20],
        ['multihop-iter', 3],
      ]),
      { arms: ['magma', 'multihop-iter'] },
    ),
    resolveBootstrapEpsilon(
      new Map([
        ['magma', 20],
        ['multihop-iter', 12],
      ]),
      { arms: ['magma', 'multihop-iter'] },
    ),
    resolveBootstrapEpsilon(new Map(), { arms: ['magma', 'multihop-iter'], override: 0.5 }),
    resolveBootstrapEpsilon(new Map(), { arms: ['magma', 'multihop-iter'], override: Number.NaN }),
  ]
  out.push({ epsilons: eps })
  return out
}

describe('Step 2 acceptance — routing is byte-identical to main @ 67ff69f on a fixed seed', () => {
  it('reproduces the frozen decision sequence exactly (deep-equal, JSON round-trip)', () => {
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as unknown[]
    const now = JSON.parse(JSON.stringify(generate())) as unknown[]
    expect(now).toEqual(golden)
    expect(now).toHaveLength(61) // 40 briefing decisions + 20 exploration decisions + 1 epsilon block
  })

  it('the fixture itself has not been quietly regenerated: it still carries both arms and both branches', () => {
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as Array<{
      out?: { servedArm: string; explore: boolean; record: boolean }
    }>
    const served = new Set(golden.filter((g) => g.out).map((g) => g.out!.servedArm))
    expect(served.has('multihop-iter')).toBe(true)
    expect(served.has('magma')).toBe(true)
    expect(golden.some((g) => g.out && !g.out.record)).toBe(true) // lever-off / machine rows stay unrecorded
    expect(golden.some((g) => g.out && g.out.explore)).toBe(true)
  })
})

describe('Step 2 — purpose-frame names are ALIASES, not new behaviour', () => {
  it('BRIEFING_ALTERNATE_TOOLS is the very same array object as BRIEFING_CHALLENGER_ARMS', () => {
    expect(BRIEFING_ALTERNATE_TOOLS).toBe(BRIEFING_CHALLENGER_ARMS)
    expect([...BRIEFING_ALTERNATE_TOOLS]).toEqual(['multihop-iter'])
  })

  it('resolveLiveIncumbent delegates to resolveBriefingDefaultTool under every env value', () => {
    for (const v of [undefined, 'magma', 'MAGMA', 'hybrid', 'anything-else']) {
      const env: NodeJS.ProcessEnv = v === undefined ? {} : { SCNS_LIVE_MEMORY_BRIEFING: v }
      expect(resolveLiveIncumbent(env)).toBe(resolveBriefingDefaultTool(env))
    }
    expect(resolveBriefingDefaultTool({})).toBe('magma')
    expect(resolveBriefingDefaultTool({ SCNS_LIVE_MEMORY_BRIEFING: 'hybrid' })).toBe('hybrid')
  })

  it('resolveBriefingTools = [default, ...alternates] and never duplicates the default', () => {
    expect(resolveBriefingTools({})).toEqual(['magma', 'multihop-iter'])
    expect(resolveBriefingTools({ SCNS_LIVE_MEMORY_BRIEFING: 'hybrid' })).toEqual([
      'hybrid',
      'multihop-iter',
    ])
  })

  it("the classifier's RETRIEVAL_TOOLS are exactly the stored explore_arm strings the router uses", () => {
    // Stored rows are history and are never rewritten: the tool names ARE the arm names.
    expect([...RETRIEVAL_TOOLS]).toEqual([...EXPLORE_ARMS])
  })
})

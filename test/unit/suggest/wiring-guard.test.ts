/**
 * WIRING GUARD — the seams that unit tests structurally cannot reach.
 *
 * Both F1 and C1 fix a *call site* inside `src/cli.ts`. `cli.ts` is a Commander entry point with
 * top-level side effects, so it cannot be imported into a unit test; every behavioural test therefore
 * exercises the extracted function while the line that CALLS it stays uncovered. An independent
 * review proved the consequence: deleting the entire F1 cron caller left the whole suite green.
 *
 * These assertions read the source and fail if the wiring is removed. They are deliberately narrow —
 * they pin the connection, not the formatting — and they are a floor, not a substitute for the live
 * broker verification recorded in `docs/evidence/`.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src')
const cli = readFileSync(join(SRC, 'cli.ts'), 'utf-8')

/** The body of the scheduled `weekly-promotion-review` handler. */
function cronHandlerBody(): string {
  const start = cli.indexOf(`registerTaskHandler('weekly-promotion-review'`)
  expect(start).toBeGreaterThan(-1)
  const end = cli.indexOf(`registerTaskHandler(`, start + 1)
  return cli.slice(start, end === -1 ? cli.length : end)
}

describe('F1 — the Monday cron must render and persist the report itself', () => {
  const body = cronHandlerBody()

  it('renders the routing-accuracy section and the full document from the shared module', () => {
    expect(body).toContain('renderRoutingAccuracySection')
    expect(body).toContain('renderWeeklyReviewDocument')
  })

  it('writes the report to a file', () => {
    expect(body).toContain('writeWeeklyReviewFile')
  })

  it('no longer tells the human to go run a second command', () => {
    // The pre-fix handler's entire output was a pino line ending "run `scns review weekly`".
    expect(body).not.toContain('run \\`scns review weekly\\`')
  })

  it('Step 2: no longer computes a promote/retire verdict or raises an arm-promotion proposal', () => {
    // NORTH_STAR "Retrieval design intent" (2026-08-14): the tools are purpose-routed, not rivals.
    // The reward learner's promotion seam is disconnected from BOTH live review paths.
    expect(body).not.toContain('runRewardReport(')
    expect(body).not.toContain('humanOutcomePromotion')
    expect(body).not.toContain('promotionVerdict')
    expect(cli).not.toContain('promotionVerdict')
    expect(cli).not.toContain('humanOutcomePromotion')
    expect(cli).not.toContain('armPromotion')
  })

  it('logs the routing numbers it rendered, so the pino line is not silent about the section', () => {
    expect(body).toContain('routingAgreement')
    expect(body).toContain('routingClassifiedRows')
  })

  it('guards the file write so it cannot starve the proposal_outcomes sweep', () => {
    const write = body.indexOf('writeWeeklyReviewFile(')
    const sweep = body.indexOf('recordSuggestionOutcomeFn')
    expect(write).toBeGreaterThan(-1)
    expect(sweep).toBeGreaterThan(write) // the sweep is downstream …
    expect(body.slice(Math.max(0, write - 300), write)).toContain('try {') // … and the write is guarded
  })
})

describe('C1 — every live settle call site must pass its provenance', () => {
  it('the re-ask settle at cli.ts stamps an answer_source', () => {
    const i = cli.indexOf('settleHumanOutcomeForAttempt(')
    expect(i).toBeGreaterThan(-1)
    const call = cli.slice(i, cli.indexOf(')', cli.indexOf('re-asked', i)) + 1)
    expect(call).toContain("'re-asked'")
    // Without this argument the label lands with a permanently NULL provenance [FR-034/SC-009].
    expect(call).toContain('human-reask:')
  })

  it('the entity settle in outcome-writer stamps an answer_source', () => {
    const src = readFileSync(join(SRC, 'suggest', 'outcome-writer.ts'), 'utf-8')
    const i = src.indexOf('settleHumanOutcomeForEntity(')
    expect(i).toBeGreaterThan(-1)
    expect(src.slice(i, i + 800)).toContain('answerSource:')
  })
})

/**
 * Slice the full argument object of a `foo({ … })` call by BRACE MATCHING.
 *
 * A naive `indexOf('})')` stops at the first `: {})` of a spread-conditional — which these call sites
 * are full of — and reported a correctly-wired call site as unwired. The first draft of this guard
 * did exactly that and produced a false RED.
 */
function argsFrom(src: string, callIndex: number): string {
  const open = src.indexOf('{', callIndex)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error('unbalanced braces from index ' + callIndex)
}

describe('Step 2 — the routing section renders on BOTH live paths, from ONE module', () => {
  const callArgs = (i: number): string => argsFrom(cli, i)

  it('both buildWeeklySession call sites exist and neither passes a promotion or caveats (the proposal is gone)', () => {
    const sites: number[] = []
    for (let i = cli.indexOf('buildWeeklySession({'); i !== -1; i = cli.indexOf('buildWeeklySession({', i + 1))
      sites.push(i)
    // Pinned: two callers, exactly as F1 established. A third would need its own wiring and would
    // otherwise slip past this guard entirely.
    expect(sites).toHaveLength(2)
    for (const i of sites) {
      expect(callArgs(i)).not.toContain('promotionVerdict')
      expect(callArgs(i)).not.toContain('sampleCaveats')
    }
  })

  it('both paths render the routing-accuracy section (cron + `scns review weekly`)', () => {
    const calls = cli.split('renderRoutingAccuracySection(').length - 1
    expect(calls).toBe(2)
    // FR-038 caveats are measured INSIDE the section (weekly-report.ts) — never invented at a call
    // site. A literal empty array would render as "no known open defect", a clean bill of health
    // nobody earned.
    expect(cli).not.toContain('sampleCaveats: []')
    const report = readFileSync(join(SRC, 'suggest', 'weekly-report.ts'), 'utf-8')
    expect(report).toContain('detectSampleCaveats(s, liveTools)')
  })
})

/**
 * PR #24, minor finding 3 — `evidence` must stay REQUIRED on `RoutingAccuracyInput`.
 *
 * `tsconfig.json` excludes `test/`, so a type-level regression cannot be caught by a fixture: making
 * the field optional again would re-create #20 by OMISSION — a future caller that never wires the
 * discriminant would silently assert a clean read, with no type error and no failing test. Fifteen
 * existing call sites were relying on exactly that default. This guard reads the source instead.
 * (Moved from `weekly-format.ts` to `routing-format.ts` in Step 2; the invariant is unchanged.)
 */
describe('PR#24-3 — the evidence discriminant cannot go back to defaulting to `ok`', () => {
  const fmt = readFileSync(join(SRC, 'suggest', 'routing-format.ts'), 'utf-8')

  it('declares `evidence` as a required field, not an optional one', () => {
    expect(fmt).toContain('readonly evidence:')
    expect(fmt).not.toContain('readonly evidence?:')
  })

  it('does not re-introduce a default at the read site', () => {
    expect(fmt).not.toMatch(/input\.evidence\s*\?\?/)
  })
})

/**
 * PR #24, finding A — `absent` means ENOENT, and `existsSync` cannot express that.
 *
 * Behaviourally covered in `test/unit/memory/experience-store.test.ts`, but that test needs a
 * `chmod 000` directory, which does not reproduce for root. This guard is the cheap floor: the strict
 * read must not go back to an `existsSync` gate under any environment.
 */
describe('PR#24-A — the strict evidence read does not gate `absent` on existsSync', () => {
  const store = readFileSync(join(SRC, 'memory', 'experience-store.ts'), 'utf-8')

  it('classifies by errno rather than by existence', () => {
    expect(store).not.toMatch(/existsSync\(/)
    expect(store).toContain("code === 'ENOENT'")
  })
})

/**
 * Phase 10f, re-grade finding 4 — the phase's own CRITICAL fix was defended by nothing.
 *
 * The defect was that a build failure got banked in `proposal_outcomes` as `rejected`, a member of
 * `FAILED_VERDICTS`, so the learner counted John's APPROVAL as his REFUSAL. The fix is a two-ended
 * wire: the arbiter emits an explicit `verdict` and `cli.ts` prefers it over the old
 * `passed ? 'implemented' : 'rejected'` guess.
 *
 * An independent re-grade reverted BOTH ends and reported `Tests 7447 passed | 2 skipped (7449)`
 * with `tsc --noEmit` clean — byte-identical to the fixed tree. The three behavioural tests filed
 * under this finding assert properties of `recordProposalOutcome` and `FAILED_VERDICTS`; none of
 * them touches the wiring that WAS the defect. This is the floor that would have caught it.
 */
describe('Phase 10f — the gate-failure verdict wiring', () => {
  const arbiter = readFileSync(join(SRC, 'broker', 'services', 'quality-gate-arbiter.ts'), 'utf-8')

  /** The body of the `onOutcome` callback the CLI hands to the brain. */
  function onOutcomeBody(): string {
    // Anchored on the property name alone, not on the full destructuring line: that line is 88
    // chars against a prettier `printWidth` of 100, so adding one more field would wrap it and
    // fail this guard with a message that says nothing about the invariant it defends.
    const start = cli.indexOf('onOutcome: ({')
    expect(start).toBeGreaterThan(-1)
    const end = cli.indexOf('if (!description) return', start)
    expect(end).toBeGreaterThan(start)
    return cli.slice(start, end)
  }

  it('the arbiter emits an explicit verdict rather than leaving the reader to infer one', () => {
    expect(arbiter).toContain("verdict: passed ? 'implemented' : 'failed'")
  })

  it('the CLI banks the arbiter’s verdict, not a guess derived from `passed`', () => {
    const body = onOutcomeBody()
    expect(body).toContain("verdict ?? (passed ? 'implemented' : 'failed')")
  })

  it('no seam re-introduces `rejected` as the outcome of a failed build', () => {
    expect(onOutcomeBody()).not.toMatch(/passed\s*\?\s*'implemented'\s*:\s*'rejected'/)
    expect(arbiter).not.toMatch(/passed\s*\?\s*'implemented'\s*:\s*'rejected'/)
  })
})

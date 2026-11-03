/**
 * WS B — Reproduction Guard
 *
 * Pure helper used by the QA agent's prompt to decide whether a dev's
 * staged diff actually demonstrates a reproduction-first fix.
 *
 * Inputs:
 *   - stagedDiff: raw `git diff --cached` output.
 *   - baselineTestRunSummary: result of running the new tests against the
 *     UNSTAGED tree (i.e. tests applied via `git stash pop` / cherry-pick of
 *     the test portion only — source change NOT applied).
 *   - postEditTestRunSummary: result of running the new tests against the
 *     fully staged tree (tests + source change).
 *
 * Verdicts:
 *   - 'fail' if the diff is tests-only (no source change to validate).
 *   - 'pass' (with caveat) if the diff is source-only (no test added to
 *     guard the change — call out, don't block).
 *   - 'pass' if new tests failed in the baseline and pass post-edit
 *     (genuine reproduction → fix).
 *   - 'fail' if new tests already passed in the baseline (the tests do not
 *     reproduce a real bug — they don't earn the source change).
 */

export interface TestRunSummary {
  readonly failingTests: readonly string[]
  readonly passingTests: readonly string[]
}

export interface ReproductionEvidenceInput {
  readonly stagedDiff: string
  readonly baselineTestRunSummary: TestRunSummary
  readonly postEditTestRunSummary: TestRunSummary
}

export interface ReproductionVerdict {
  readonly verdict: 'pass' | 'fail'
  readonly reason: string
}

interface DiffShape {
  readonly hasSourceChanges: boolean
  readonly hasTestChanges: boolean
}

function classifyDiff(stagedDiff: string): DiffShape {
  const filePaths = new Set<string>()
  // Capture both `+++ b/<path>` and `--- a/<path>` to catch deletions too.
  const re = /^(?:\+\+\+ b\/|--- a\/)(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(stagedDiff)) !== null) {
    const p = (m[1] ?? '').trim()
    if (p && p !== '/dev/null') filePaths.add(p)
  }
  let hasSourceChanges = false
  let hasTestChanges = false
  for (const p of filePaths) {
    if (isTestPath(p)) hasTestChanges = true
    else hasSourceChanges = true
  }
  return { hasSourceChanges, hasTestChanges }
}

function isTestPath(path: string): boolean {
  if (path.startsWith('test/') || path.startsWith('tests/')) return true
  if (/\.test\.[jt]sx?$/.test(path)) return true
  if (/\.spec\.[jt]sx?$/.test(path)) return true
  if (/__tests__\//.test(path)) return true
  return false
}

export function evaluateReproductionEvidence(
  input: ReproductionEvidenceInput,
): ReproductionVerdict {
  const shape = classifyDiff(input.stagedDiff)

  if (!shape.hasSourceChanges && !shape.hasTestChanges) {
    return { verdict: 'fail', reason: 'empty staged diff: nothing to validate' }
  }

  if (shape.hasTestChanges && !shape.hasSourceChanges) {
    return {
      verdict: 'fail',
      reason:
        'tests-only diff: no source change accompanies the new tests, so there is nothing to reproduce against',
    }
  }

  if (shape.hasSourceChanges && !shape.hasTestChanges) {
    return {
      verdict: 'pass',
      reason:
        'source-only change with caveat: no new tests were added to guard against regression',
    }
  }

  // Tests + source: require baseline failure → post-edit pass.
  const baselineFailures = input.baselineTestRunSummary.failingTests
  const postEditPasses = new Set(input.postEditTestRunSummary.passingTests)

  if (baselineFailures.length === 0) {
    return {
      verdict: 'fail',
      reason:
        'new tests already passed in the baseline (without the source change) — they do not reproduce a real bug',
    }
  }

  const reproducedThenFixed = baselineFailures.filter((t) => postEditPasses.has(t))
  if (reproducedThenFixed.length === 0) {
    return {
      verdict: 'fail',
      reason:
        'baseline test failures were not turned into post-edit passes — the source change does not fix what the tests reproduce',
    }
  }

  return {
    verdict: 'pass',
    reason: `reproduced ${reproducedThenFixed.length} failing test(s) in the baseline that now pass post-edit`,
  }
}

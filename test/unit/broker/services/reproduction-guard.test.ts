import { describe, it, expect } from 'vitest'
import { evaluateReproductionEvidence } from '../../../../src/broker/services/reproduction-guard.js'

const TESTS_ONLY_DIFF = `diff --git a/test/unit/foo.test.ts b/test/unit/foo.test.ts
--- a/test/unit/foo.test.ts
+++ b/test/unit/foo.test.ts
@@ -1,3 +1,8 @@
+it('reproduces the bug', () => {
+  expect(buggy()).toBe('fixed')
+})
`

const SOURCE_ONLY_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
-export const buggy = () => 'broken'
+export const buggy = () => 'fixed'
`

const TESTS_AND_SOURCE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
-export const buggy = () => 'broken'
+export const buggy = () => 'fixed'
diff --git a/test/unit/foo.test.ts b/test/unit/foo.test.ts
--- a/test/unit/foo.test.ts
+++ b/test/unit/foo.test.ts
@@ -1,3 +1,8 @@
+it('reproduces the bug', () => {
+  expect(buggy()).toBe('fixed')
+})
`

describe('evaluateReproductionEvidence (WS B)', () => {
  it('fails when the staged diff is tests-only (no source change)', () => {
    const verdict = evaluateReproductionEvidence({
      stagedDiff: TESTS_ONLY_DIFF,
      baselineTestRunSummary: { failingTests: ['foo > reproduces the bug'], passingTests: [] },
      postEditTestRunSummary: { failingTests: [], passingTests: ['foo > reproduces the bug'] },
    })
    expect(verdict.verdict).toBe('fail')
    expect(verdict.reason).toMatch(/tests[- ]only/i)
  })

  it('passes (with caveat) when the staged diff is source-only (no test change)', () => {
    const verdict = evaluateReproductionEvidence({
      stagedDiff: SOURCE_ONLY_DIFF,
      baselineTestRunSummary: { failingTests: [], passingTests: [] },
      postEditTestRunSummary: { failingTests: [], passingTests: [] },
    })
    expect(verdict.verdict).toBe('pass')
    expect(verdict.reason).toMatch(/caveat|no test/i)
  })

  it('passes when new tests FAILED pre-edit and PASS post-edit', () => {
    const verdict = evaluateReproductionEvidence({
      stagedDiff: TESTS_AND_SOURCE_DIFF,
      baselineTestRunSummary: { failingTests: ['foo > reproduces the bug'], passingTests: [] },
      postEditTestRunSummary: { failingTests: [], passingTests: ['foo > reproduces the bug'] },
    })
    expect(verdict.verdict).toBe('pass')
  })

  it('fails when new tests already PASS in the baseline (do not reproduce a bug)', () => {
    const verdict = evaluateReproductionEvidence({
      stagedDiff: TESTS_AND_SOURCE_DIFF,
      baselineTestRunSummary: { failingTests: [], passingTests: ['foo > reproduces the bug'] },
      postEditTestRunSummary: { failingTests: [], passingTests: ['foo > reproduces the bug'] },
    })
    expect(verdict.verdict).toBe('fail')
    expect(verdict.reason).toMatch(/already passed|did not fail|do not reproduce/i)
  })
})
